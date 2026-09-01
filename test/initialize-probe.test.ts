import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { getRuntimeConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";
import { MemoryWaitlistStore } from "../src/waitlist.ts";

// Spec-correct Streamable HTTP initialize probe.
//
// This is the same request documented in the README quickstart and re-runnable
// against the production endpoint (https://medlock.ai/api/mcp). It uses raw
// fetch rather than the official client on purpose: it pins the wire contract
// (JSON-RPC initialize POST with `Accept: application/json, text/event-stream`
// answered as an SSE `event: message` frame) instead of whatever the client
// library currently tolerates.

const INITIALIZE_BODY = {
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "medlock-initialize-probe", version: "1.0.0" },
    protocolVersion: "2025-03-26",
  },
};

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

function serve(env: Record<string, string> = {}): URL {
  const config = getRuntimeConfig({
    ALLOWED_HOSTS: "localhost,127.0.0.1",
    ALLOWED_ORIGINS: "http://localhost:3000,https://claude.ai",
    CANONICAL_HOST: "medlock.ai",
    DATA_DIR: ".test-data",
    LEGACY_HOSTS: "",
    MEDLOCK_VERSION: "test",
    PORT: "0",
    PUBLIC_DIR: `${import.meta.dir}/../public`,
    ...env,
  });
  const server = Bun.serve({ fetch: createHandler({ config, waitlistStore: new MemoryWaitlistStore() }), port: 0 });
  servers.push(server);
  return new URL("/api/mcp", server.url);
}

function initialize(endpoint: URL, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(endpoint, {
    body: JSON.stringify(INITIALIZE_BODY),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

function parseSseMessage(sseBody: string): { event: string; data: Record<string, unknown> } {
  const event = sseBody.match(/^event: (.+)$/m)?.[1];
  const data = sseBody.match(/^data: (.+)$/m)?.[1];
  expect(event).toBeDefined();
  expect(data).toBeDefined();
  return { event: event as string, data: JSON.parse(data as string) as Record<string, unknown> };
}

describe("initialize probe", () => {
  test("answers a spec-correct initialize with an SSE frame carrying serverInfo and the demo-data disclosure", async () => {
    const response = await initialize(serve());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toStartWith("text/event-stream");

    const { event, data } = parseSseMessage(await response.text());
    expect(event).toBe("message");
    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe(1);

    const result = data.result as {
      instructions: string;
      protocolVersion: string;
      serverInfo: { name: string; version: string };
    };
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.serverInfo.name).toBe("medlock");
    expect(result.serverInfo.version).toBe("test");
    expect(result.instructions).toContain("demo Solid Pod data");
  });

  test("rejects an initialize from an origin outside the allow-list", async () => {
    const response = await initialize(serve(), { Origin: "https://evil.example" });

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("rejects opaque and malformed Origin headers instead of treating them as absent", async () => {
    for (const origin of [
      "null",
      "://malformed",
      "https://claude.ai/",
      "https://claude.ai/path",
      "https://user@claude.ai",
      "https://claude.ai?query",
      "https://claude.ai#fragment",
    ]) {
      const response = await initialize(serve(), { Origin: origin });

      expect(response.status, origin).toBe(403);
      expect(response.headers.get("Access-Control-Allow-Origin"), origin).toBeNull();
      expect(response.headers.get("X-Content-Type-Options"), origin).toBe("nosniff");
    }
  });

  test("echoes an allow-listed origin in CORS headers", async () => {
    const response = await initialize(serve(), { Origin: "https://claude.ai" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("normalizes case but does not let wildcard origins change ports", async () => {
    const normalized = await initialize(serve(), { Origin: "HTTPS://CLAUDE.AI" });
    expect(normalized.status).toBe(200);
    expect(normalized.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");

    const endpoint = serve({ ALLOWED_ORIGINS: "https://*.run.app" });
    const allowed = await initialize(endpoint, { Origin: "https://example.run.app" });
    const wrongPort = await initialize(endpoint, { Origin: "https://example.run.app:444" });

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://example.run.app");
    expect(wrongPort.status).toBe(403);
    expect(wrongPort.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("rejects every unsupported method without affecting the next POST", async () => {
    const endpoint = serve();

    for (const method of ["GET", "DELETE", "PUT", "PATCH"]) {
      const rejected = await fetch(endpoint, { method });
      expect(rejected.status, method).toBe(405);
      expect(rejected.headers.get("Allow"), method).toBe("POST, OPTIONS");
    }

    const initialized = await initialize(endpoint);
    expect(initialized.status).toBe(200);
    expect(parseSseMessage(await initialized.text()).data.id).toBe(1);
  });

  test("requires the bearer token when MEDLOCK_MCP_TOKEN is configured", async () => {
    const token = "probe-".repeat(6);
    const endpoint = serve({ MEDLOCK_MCP_TOKEN: token });

    const missing = await initialize(endpoint);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toBe('Bearer realm="medlock-mcp"');

    const wrong = await initialize(endpoint, { Authorization: "Bearer wrong" });
    expect(wrong.status).toBe(401);

    const authorized = await initialize(endpoint, { Authorization: `Bearer ${token}` });
    expect(authorized.status).toBe(200);
    expect(parseSseMessage(await authorized.text()).event).toBe("message");
  });

  test("rejects weak private-deployment bearer tokens during configuration", () => {
    expect(() => getRuntimeConfig({ MEDLOCK_MCP_TOKEN: "too-short" })).toThrow("at least 32 bytes");
  });

  test("an unrecognised waitlist backend is refused, not silently downgraded", () => {
    // Falling back to the file backend would quietly put a deployment that
    // meant to say "firestore" onto a backend with no compare-and-swap.
    expect(() => getRuntimeConfig({ WAITLIST_BACKEND: "firestor" })).toThrow(
      "WAITLIST_BACKEND must be exactly",
    );
    expect(() => getRuntimeConfig({ WAITLIST_BACKEND: "postgres" })).toThrow(
      "WAITLIST_BACKEND must be exactly",
    );
    // Unset still means the local default.
    expect(getRuntimeConfig({}).waitlistBackend).toBe("file");
    expect(getRuntimeConfig({ WAITLIST_BACKEND: "" }).waitlistBackend).toBe("file");
  });

  test("a deployed service must name Firestore explicitly", () => {
    const active = Buffer.alloc(32, 31).toString("base64url");
    for (const backend of ["file", "memory"]) {
      expect(() =>
        getRuntimeConfig({
          PLATFORM_DEPLOY_ENVIRONMENT: "production",
          WAITLIST_BACKEND: backend,
          WAITLIST_IDENTITY_KEYSET: active,
        })
      ).toThrow("must set WAITLIST_BACKEND=firestore");
    }
    expect(
      getRuntimeConfig({
        PLATFORM_DEPLOY_ENVIRONMENT: "production",
        WAITLIST_BACKEND: "firestore",
        WAITLIST_IDENTITY_KEYSET: active,
      }).waitlistBackend,
    ).toBe("firestore");
  });

  test("requires stable waitlist identity secrets in deployed services and accepts one prior key", () => {
    const active = Buffer.alloc(32, 21).toString("base64url");
    const prior = Buffer.alloc(32, 22).toString("base64url");

    expect(() =>
      getRuntimeConfig({
        PLATFORM_DEPLOY_ENVIRONMENT: "production",
        WAITLIST_BACKEND: "firestore",
      }),
    ).toThrow("WAITLIST_IDENTITY_KEYSET is required");
    expect(() =>
      getRuntimeConfig({ WAITLIST_BACKEND: "firestore" }),
    ).toThrow("WAITLIST_IDENTITY_KEYSET is required");
    expect(() =>
      getRuntimeConfig({
        PLATFORM_DEPLOY_ENVIRONMENT: "preview",
        WAITLIST_BACKEND: "firestore",
        WAITLIST_IDENTITY_KEYSET: `${active},${active}`,
      }),
    ).toThrow("distinct prior key");

    const config = getRuntimeConfig({
      PLATFORM_DEPLOY_ENVIRONMENT: "production",
      WAITLIST_BACKEND: "firestore",
      WAITLIST_IDENTITY_KEYSET: `${active},${prior}`,
    });
    expect(config.deploymentEnvironment).toBe("production");
    expect(config.waitlistIdentitySecrets).toHaveLength(2);
    expect(config.waitlistIdentitySecrets[0]?.byteLength).toBe(32);
  });

  test("binds the Identity Platform return URL to the exact canonical confirmation endpoint", () => {
    const activeKey = Buffer.alloc(32, 41).toString("base64url");
    const activation = {
      IDENTITY_PLATFORM_AUDIENCE: "medlock-1025243085",
      RECAPTCHA_PROJECT_ID: "medlock-1025243085",
      RECAPTCHA_SITE_KEY: "public_site_key_12345678901234567890",
      WAITLIST_ACTIVATION_ENABLED: "true",
      WAITLIST_BACKEND: "firestore",
      WAITLIST_IDENTITY_KEYSET: activeKey,
    };
    expect(() =>
      getRuntimeConfig({
        ...activation,
        CANONICAL_HOST: "medlock.ai/attacker",
        IDENTITY_PLATFORM_CONTINUE_URL: "https://medlock.ai/api/waitlist/confirm",
      })
    ).toThrow("CANONICAL_HOST");
    for (const returnUrl of [
      "https://attacker.example/api/waitlist/confirm",
      "https://medlock.ai/other",
      "https://medlock.ai:444/api/waitlist/confirm",
    ]) {
      expect(() =>
        getRuntimeConfig({
          ...activation,
          CANONICAL_HOST: "medlock.ai",
          IDENTITY_PLATFORM_CONTINUE_URL: returnUrl,
        })
      ).toThrow("canonical /api/waitlist/confirm");
    }
    expect(
      getRuntimeConfig({
        ...activation,
        CANONICAL_HOST: "MEDLOCK.AI",
        IDENTITY_PLATFORM_CONTINUE_URL: "https://medlock.ai/api/waitlist/confirm",
      }).identityPlatformContinueUrl,
    ).toBe("https://medlock.ai/api/waitlist/confirm");
  });

  test("rejects JSON-RPC batches and oversized MCP bodies", async () => {
    const endpoint = serve();
    const batch = await fetch(endpoint, {
      body: JSON.stringify([INITIALIZE_BODY, { ...INITIALIZE_BODY, id: 2 }]),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(batch.status).toBe(400);
    expect(await batch.json()).toEqual({ error: "JSON-RPC batches are not supported" });

    const oversized = await fetch(endpoint, {
      body: JSON.stringify({ ...INITIALIZE_BODY, padding: "x".repeat(70_000) }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "request body too large" });
  });
});
