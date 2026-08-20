import { afterEach, describe, expect, test } from "bun:test";
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

  test("echoes an allow-listed origin in CORS headers", async () => {
    const response = await initialize(serve(), { Origin: "https://claude.ai" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
  });

  test("requires the bearer token when MEDLOCK_MCP_TOKEN is configured", async () => {
    const endpoint = serve({ MEDLOCK_MCP_TOKEN: "probe-secret" });

    const missing = await initialize(endpoint);
    expect(missing.status).toBe(401);

    const wrong = await initialize(endpoint, { Authorization: "Bearer wrong" });
    expect(wrong.status).toBe(401);

    const authorized = await initialize(endpoint, { Authorization: "Bearer probe-secret" });
    expect(authorized.status).toBe(200);
    expect(parseSseMessage(await authorized.text()).event).toBe("message");
  });
});
