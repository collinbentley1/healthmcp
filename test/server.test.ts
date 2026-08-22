import { describe, expect, test } from "bun:test";
import { getRuntimeConfig } from "../src/config.ts";
import { createHandler, startServer } from "../src/server.ts";
import { MemoryWaitlistStore, type WaitlistStore } from "../src/waitlist.ts";

const config = getRuntimeConfig({
  ALLOWED_HOSTS: "localhost,127.0.0.1,healthmcp.ai,www.medlock.ai,medlock.ai",
  ALLOWED_ORIGINS: "http://localhost:3000,https://medlock.ai",
  CANONICAL_HOST: "medlock.ai",
  DATA_DIR: ".test-data",
  LEGACY_HOSTS: "healthmcp.ai",
  MEDLOCK_VERSION: "test",
  PORT: "0",
  PUBLIC_DIR: `${import.meta.dir}/../public`,
});

delete Bun.env.PLATFORM_DEPLOY_NONCE;

describe("server", () => {
  test("serves static homepage and favicon", async () => {
    const handler = createHandler({ config });
    const page = await handler(new Request("http://localhost/"));
    const favicon = await handler(new Request("http://localhost/favicon.ico"));

    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Medlock");
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("Content-Type")).toBe("image/svg+xml");
  });

  test("serves the platform liveness probe at /livez", async () => {
    const handler = createHandler({ config });
    const response = await handler(new Request("http://localhost/livez"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("echoes the platform deployment nonce at /livez when configured", async () => {
    Bun.env.PLATFORM_DEPLOY_NONCE = "test-deployment-nonce";

    try {
      const handler = createHandler({ config });
      const response = await handler(new Request("http://localhost/livez"));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        deployment: "test-deployment-nonce",
        ok: true,
      });
    } finally {
      delete Bun.env.PLATFORM_DEPLOY_NONCE;
    }
  });

  test("sends HSTS on page and redirect responses", async () => {
    const handler = createHandler({ config });
    const page = await handler(new Request("http://localhost/"));
    const redirect = await handler(
      new Request("https://healthmcp.ai/", {
        headers: { Host: "healthmcp.ai" },
      }),
    );

    expect(page.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    expect(redirect.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
  });

  test("serves the Open Graph image as PNG", async () => {
    const handler = createHandler({ config });
    const image = await handler(new Request("http://localhost/assets/og-image.png"));

    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/png");
  });

  test("rejects malformed percent-encoded paths inside the hardened response boundary", async () => {
    const response = await createHandler({ config })(new Request("http://localhost/%E0%A4%A"));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("bad request");
    expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("redirects legacy healthmcp host to canonical medlock.ai", async () => {
    const response = await createHandler({ config })(
      new Request("https://healthmcp.ai/path?x=1", {
        headers: { Host: "healthmcp.ai" },
      }),
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://medlock.ai/path?x=1");
  });

  test("accepts waitlist JSON and ignores spoofed forwarding headers when rate limiting", async () => {
    const handler = createHandler({
      config,
      waitlistIdentitySecret: new Uint8Array(32).fill(7),
      waitlistStore: new MemoryWaitlistStore(),
    });
    let requestIndex = 0;
    const request = (cookie?: string) =>
      new Request("http://localhost/api/waitlist", {
        body: JSON.stringify({ email: "person@example.com" }),
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          "Content-Type": "application/json",
          "X-Forwarded-For": `203.0.113.${requestIndex++}`,
        },
        method: "POST",
      });

    const response = await handler(request());
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ duplicate: false, ok: true });
    expect(cookie).toStartWith("medlock_waitlist_client=");

    for (let index = 0; index < 4; index += 1) {
      const duplicate = await handler(request(cookie));
      expect(duplicate.status).toBe(202);
      expect(await duplicate.json()).toEqual({ duplicate: true, ok: true });
      expect(duplicate.headers.get("set-cookie")).toBeNull();
    }

    expect((await handler(request(cookie))).status).toBe(429);
  });

  test("keeps distinct clients independent without consulting Bun's proxy socket", async () => {
    const server = startServer(
      { ...config, port: 0 },
      {
        waitlistIdentitySecret: new Uint8Array(32).fill(8),
        waitlistStore: new MemoryWaitlistStore(),
      },
    );

    try {
      const first = await fetch(new URL("/api/waitlist", server.url), {
        body: JSON.stringify({ email: "first@example.com" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const firstCookie = first.headers.get("set-cookie")?.split(";", 1)[0];
      expect(first.status).toBe(202);
      expect(firstCookie).toStartWith("medlock_waitlist_client=");

      for (let index = 0; index < 4; index += 1) {
        const response = await fetch(new URL("/api/waitlist", server.url), {
          body: JSON.stringify({ email: "first@example.com" }),
          headers: {
            Cookie: firstCookie!,
            "Content-Type": "application/json",
            "X-Forwarded-For": `203.0.113.${index}`,
          },
          method: "POST",
        });
        expect(response.status).toBe(202);
      }

      expect(
        (
          await fetch(new URL("/api/waitlist", server.url), {
            body: JSON.stringify({ email: "first@example.com" }),
            headers: { Cookie: firstCookie!, "Content-Type": "application/json" },
            method: "POST",
          })
        ).status,
      ).toBe(429);

      const independent = await fetch(new URL("/api/waitlist", server.url), {
        body: JSON.stringify({ email: "second@example.com" }),
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.0",
        },
        method: "POST",
      });
      expect(independent.status).toBe(202);
      expect(independent.headers.get("set-cookie")).not.toBe(firstCookie);
    } finally {
      server.stop(true);
    }
  });

  test("caps aggregate waitlist traffic even when client cookies differ", async () => {
    const handler = createHandler({ config, waitlistStore: new MemoryWaitlistStore() });
    const request = () =>
      new Request("http://localhost/api/waitlist", {
        body: JSON.stringify({ email: "person@example.com" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

    for (let index = 0; index < 60; index += 1) {
      expect((await handler(request())).status).toBe(202);
    }
    expect((await handler(request())).status).toBe(429);
  });

  test("applies the hardened response boundary to waitlist preflights", async () => {
    const response = await createHandler({ config })(
      new Request("http://localhost/api/waitlist", {
        headers: { Origin: "http://localhost:3000" },
        method: "OPTIONS",
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("rejects an oversized waitlist body before parsing or persistence", async () => {
    const handler = createHandler({ config, waitlistStore: new MemoryWaitlistStore() });
    const response = await handler(
      new Request("http://localhost/api/waitlist", {
        body: JSON.stringify({ email: `${"a".repeat(9_000)}@example.com` }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body too large" });
  });

  test("rejects CORS-safelisted content types that merely contain application/json", async () => {
    const response = await createHandler({ config, waitlistStore: new MemoryWaitlistStore() })(
      new Request("http://localhost/api/waitlist", {
        body: JSON.stringify({ email: "person@example.com" }),
        headers: { "Content-Type": "text/plain; x=application/json", Origin: "https://attacker.example" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "expected application/json" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("keeps waitlist store failures inside the hardened API boundary", async () => {
    const throwingStore: WaitlistStore = {
      get: () => Promise.reject(new Error("private waitlist marker")),
      put: () => Promise.reject(new Error("private waitlist marker")),
    };
    const response = await createHandler({ config, waitlistStore: throwingStore })(
      new Request("http://localhost/api/waitlist", {
        body: JSON.stringify({ email: "person@example.com" }),
        headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
        method: "POST",
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toBe('{"error":"internal server error"}');
    expect(body).not.toContain("private waitlist marker");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("does not expose thrown error details in API responses", async () => {
    const handler = createHandler({
      config,
      mcpEndpoint: {
        handle: () => Promise.reject(new Error("private stack marker")),
      },
    });
    const response = await handler(
      new Request("http://localhost/api/mcp", {
        body: "{}",
        headers: { "Content-Type": "application/json", Origin: "https://medlock.ai" },
        method: "POST",
      }),
    );
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(responseText).toBe('{"error":"internal server error"}');
    expect(responseText).not.toContain("private stack marker");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://medlock.ai");
  });
});
