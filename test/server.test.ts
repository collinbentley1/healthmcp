import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { getRuntimeConfig } from "../src/config.ts";
import { createHandler, startServer } from "../src/server.ts";
import { resolveWaitlistClient } from "../src/waitlist-client.ts";
import { MemoryWaitlistStore, type WaitlistStore } from "../src/waitlist.ts";

const UTF8 = new TextEncoder();

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

  test("limits liveness and static routes to safe read methods", async () => {
    const handler = createHandler({ config });

    for (const [method, path] of [
      ["POST", "/"],
      ["PUT", "/scan"],
      ["DELETE", "/livez"],
    ] as const) {
      const response = await handler(new Request(`http://localhost${path}`, { method }));

      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(await response.text()).toBe("method not allowed");
    }

    const pageGet = await handler(new Request("http://localhost/"));
    const pageHead = await handler(new Request("http://localhost/", { method: "HEAD" }));
    const liveGet = await handler(new Request("http://localhost/livez"));
    const liveHead = await handler(new Request("http://localhost/livez", { method: "HEAD" }));
    const pageBody = await pageGet.text();
    const liveBody = await liveGet.text();

    expect(pageHead.status).toBe(200);
    expect(pageHead.body).toBeNull();
    expect(pageHead.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(pageHead.headers.get("Content-Length")).toBe(pageGet.headers.get("Content-Length"));
    expect(Number(pageGet.headers.get("Content-Length"))).toBe(UTF8.encode(pageBody).byteLength);
    expect(await pageHead.text()).toBe("");
    expect(liveHead.status).toBe(200);
    expect(liveHead.body).toBeNull();
    expect(liveHead.headers.get("Content-Type")).toContain("application/json");
    expect(liveHead.headers.get("Content-Length")).toBe(liveGet.headers.get("Content-Length"));
    expect(Number(liveGet.headers.get("Content-Length"))).toBe(UTF8.encode(liveBody).byteLength);
    expect(await liveHead.text()).toBe("");
  });

  test("preserves GET representation lengths on HEAD over HTTP", async () => {
    const server = startServer({ ...config, port: 0 });
    const port = server.port;
    if (port === undefined) {
      server.stop(true);
      throw new Error("ephemeral test server did not expose its assigned port");
    }

    try {
      for (const pathname of ["/", "/livez"]) {
        const get = await rawHttpRequest(port, "GET", pathname);
        const head = await rawHttpRequest(port, "HEAD", pathname);

        expect(get.status).toBe(200);
        expect(head.status).toBe(200);
        const getContentLength = get.headers.get("content-length");
        const getTransferEncoding = get.headers.get("transfer-encoding");
        expect(
          (getContentLength?.length === 1 &&
            getContentLength[0] === String(get.body.byteLength) &&
            getTransferEncoding === undefined) ||
            (getContentLength === undefined &&
              getTransferEncoding?.length === 1 &&
              getTransferEncoding[0]?.toLowerCase() === "chunked"),
        ).toBe(true);
        expect(head.body.byteLength).toBe(0);
        expect(head.headers.get("content-length")).toEqual([String(get.body.byteLength)]);
        expect(get.headers.has("content-encoding")).toBe(false);
        expect(head.headers.has("content-encoding")).toBe(false);
        expect(head.headers.has("transfer-encoding")).toBe(false);
      }
    } finally {
      server.stop(true);
    }
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
      sleep: async () => {},
      waitlistIdentitySecrets: [new Uint8Array(32).fill(7)],
      waitlistStore: new MemoryWaitlistStore(),
    });
    let requestIndex = 0;
    const request = (cookie?: string) => {
      const index = requestIndex++;
      return new Request("http://localhost/api/waitlist", {
        body: JSON.stringify({ email: `person-${index}@example.com` }),
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          "Content-Type": "application/json",
          // A header the caller controls. It must buy nothing: the budget is
          // keyed on the signed client cookie and the shared buckets, never on
          // a forwarding header, so rotating it cannot widen the allowance.
          "X-Forwarded-For": `203.0.113.${index}`,
        },
        method: "POST",
      });
    };

    const response = await handler(request());
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(cookie).toStartWith("medlock_waitlist_client=");

    for (let index = 0; index < 4; index += 1) {
      const next = await handler(request(cookie));
      expect(next.status).toBe(202);
      expect(await next.json()).toEqual({ ok: true });
      expect(next.headers.get("set-cookie")).toBeNull();
    }

    expect((await handler(request(cookie))).status).toBe(429);
  });

  test("keeps distinct clients independent without consulting Bun's proxy socket", async () => {
    const server = startServer(
      { ...config, port: 0 },
      {
        waitlistIdentitySecrets: [new Uint8Array(32).fill(8)],
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
          body: JSON.stringify({ email: `first-${index}@example.com` }),
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
            body: JSON.stringify({ email: "first-spill@example.com" }),
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

  test("caps cookie-discarding callers before they can rotate through the global budget", async () => {
    const handler = createHandler({
      config,
      sleep: async () => {},
      waitlistIdentitySecrets: [new Uint8Array(32).fill(9)],
      waitlistStore: new MemoryWaitlistStore(),
    });
    const request = (index: number) =>
      new Request("http://localhost/api/waitlist", {
        body: JSON.stringify({ email: `discarded-${index}@example.com` }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

    for (let index = 0; index < 5; index += 1) {
      expect((await handler(request(index))).status).toBe(202);
    }
    const rejected = await handler(request(5));
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("set-cookie")).toBeNull();
    expect((await handler(request(6))).status).toBe(429);
  });

  test("caps aggregate waitlist traffic across authenticated client cookies", async () => {
    const identitySecret = new Uint8Array(32).fill(10);
    const handler = createHandler({
      config,
      sleep: async () => {},
      waitlistIdentitySecrets: [identitySecret],
      waitlistStore: new MemoryWaitlistStore(),
    });
    const cookies = Array.from({ length: 13 }, () => {
      const identity = resolveWaitlistClient(
        new Request("https://medlock.ai/api/waitlist"),
        [identitySecret],
      );
      const cookie = identity.setCookie?.split(";", 1)[0];
      if (!cookie) {
        throw new Error("expected a signed test client cookie");
      }
      return cookie;
    });
    const request = (cookie: string, index: number) =>
      new Request("http://localhost/api/waitlist", {
        body: JSON.stringify({ email: `aggregate-${index}@example.com` }),
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        method: "POST",
      });

    let requestIndex = 0;
    for (const cookie of cookies.slice(0, 12)) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await handler(request(cookie, requestIndex++))).status).toBe(202);
      }
    }
    expect((await handler(request(cookies[12]!, requestIndex))).status).toBe(429);
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
      confirm: () => Promise.reject(new Error("private waitlist marker")),
      create: () => Promise.reject(new Error("private waitlist marker")),
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

type RawHttpResponse = {
  readonly body: Buffer;
  readonly headers: ReadonlyMap<string, readonly string[]>;
  readonly status: number;
};

async function rawHttpRequest(port: number, method: "GET" | "HEAD", pathname: string): Promise<RawHttpResponse> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect(port, "127.0.0.1");
    socket.setTimeout(5_000);

    socket.once("connect", () => {
      socket.write(`${method} ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("timeout", () => socket.destroy(new Error("raw HTTP response timed out")));
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        const response = Buffer.concat(chunks);
        const headerBoundary = response.indexOf("\r\n\r\n");
        if (headerBoundary < 0) {
          throw new Error("raw HTTP response did not contain a header boundary");
        }

        const headerLines = response.subarray(0, headerBoundary).toString("latin1").split("\r\n");
        const statusLine = headerLines.shift();
        const status = Number(statusLine?.split(" ")[1]);
        if (!Number.isInteger(status)) {
          throw new Error("raw HTTP response did not contain a valid status");
        }

        const headers = new Map<string, string[]>();
        for (const line of headerLines) {
          const separator = line.indexOf(":");
          if (separator < 1) {
            throw new Error("raw HTTP response contained a malformed header");
          }
          const name = line.slice(0, separator).toLowerCase();
          const values = headers.get(name) ?? [];
          values.push(line.slice(separator + 1).trim());
          headers.set(name, values);
        }

        const encodedBody = response.subarray(headerBoundary + 4);
        const transferEncoding = headers.get("transfer-encoding");
        const body =
          transferEncoding?.length === 1 && transferEncoding[0]?.toLowerCase() === "chunked"
            ? decodeChunkedBody(encodedBody)
            : encodedBody;

        resolve({
          body,
          headers,
          status,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function decodeChunkedBody(encoded: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < encoded.byteLength) {
    const sizeLineEnd = encoded.indexOf("\r\n", offset);
    if (sizeLineEnd < 0) {
      throw new Error("chunked HTTP response did not contain a complete size line");
    }

    const sizeText = encoded.subarray(offset, sizeLineEnd).toString("ascii");
    if (!/^[0-9a-f]+$/i.test(sizeText)) {
      throw new Error("chunked HTTP response contained an invalid chunk size");
    }

    const size = Number.parseInt(sizeText, 16);
    offset = sizeLineEnd + 2;
    if (size === 0) {
      if (encoded.subarray(offset).toString("ascii") !== "\r\n") {
        throw new Error("chunked HTTP response contained trailers or trailing bytes");
      }
      return Buffer.concat(chunks);
    }

    const chunkEnd = offset + size;
    if (chunkEnd + 2 > encoded.byteLength || encoded.subarray(chunkEnd, chunkEnd + 2).toString("ascii") !== "\r\n") {
      throw new Error("chunked HTTP response contained an incomplete chunk");
    }
    chunks.push(encoded.subarray(offset, chunkEnd));
    offset = chunkEnd + 2;
  }

  throw new Error("chunked HTTP response did not contain a terminating chunk");
}
