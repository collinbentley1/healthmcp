import { describe, expect, test } from "bun:test";
import { getRuntimeConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";
import { MemoryWaitlistStore } from "../src/waitlist.ts";

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

  test("redirects legacy healthmcp host to canonical medlock.ai", async () => {
    const response = await createHandler({ config })(
      new Request("https://healthmcp.ai/path?x=1", {
        headers: { Host: "healthmcp.ai" },
      }),
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://medlock.ai/path?x=1");
  });

  test("accepts waitlist JSON and rate limits repeated attempts", async () => {
    const handler = createHandler({ config, waitlistStore: new MemoryWaitlistStore() });
    const request = () =>
      new Request("http://localhost/api/waitlist", {
        body: JSON.stringify({ email: "person@example.com" }),
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.22",
        },
        method: "POST",
      });

    const response = await handler(request());
    expect(response.status).toBe(201);

    for (let index = 0; index < 4; index += 1) {
      expect((await handler(request())).status).toBe(200);
    }

    expect((await handler(request())).status).toBe(429);
  });
});
