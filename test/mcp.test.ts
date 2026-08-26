import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { getRuntimeConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";
import { MemoryWaitlistStore } from "../src/waitlist.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

function serve(): URL {
  const config = getRuntimeConfig({
    ALLOWED_HOSTS: "localhost,127.0.0.1",
    ALLOWED_ORIGINS: "http://localhost:3000",
    CANONICAL_HOST: "medlock.ai",
    DATA_DIR: ".test-data",
    LEGACY_HOSTS: "",
    MEDLOCK_VERSION: "test",
    PORT: "0",
    PUBLIC_DIR: `${import.meta.dir}/../public`,
  });
  const handler = createHandler({ config, waitlistStore: new MemoryWaitlistStore() });
  const server = Bun.serve({ fetch: handler, port: 0 });
  servers.push(server);
  return new URL("/api/mcp", server.url);
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe("mcp", () => {
  test("supports Streamable HTTP listTools and tool calls with the official client", async () => {
    const client = new Client({ name: "medlock-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(serve());

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["solid_fetch_vitals", "vitals_scan"]);

    const result = (await client.callTool({
      arguments: { dataTypes: ["heart_rate"] },
      name: "solid_fetch_vitals",
    })) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { source?: unknown } | undefined)?.source).toBe("demo-solid-pod");
    expect(result.content[0]?.type).toBe("text");

    const scanResult = (await client.callTool({
      arguments: { device: "rear" },
      name: "vitals_scan",
    })) as CallToolResult;

    const expectedScanResult = {
      device: "rear",
      instructions: [
        "Open the scan URL in a trusted browser session.",
        "Grant camera access only after the browser explains the local processing flow.",
        "Keep your finger still over the camera lens until the quality indicator is stable.",
      ],
      privacyMode: "local-first",
      scanUrl: "https://medlock.ai/scan?device=rear",
      status: "ready",
      supportedMeasurements: ["heart_rate", "blood_oxygen", "respiratory_rate"],
    };

    expect(scanResult.isError).not.toBe(true);
    expect(scanResult.structuredContent).toEqual(expectedScanResult);
    expect(scanResult.content[0]?.type).toBe("text");
    if (scanResult.content[0]?.type === "text") {
      expect(JSON.parse(scanResult.content[0].text)).toEqual(expectedScanResult);
    }

    await client.close();
  });

  test("isolates simultaneous clients that use the same JSON-RPC request id", async () => {
    const endpoint = serve();
    const toolCallIds: unknown[] = [];
    const captureFetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      if (request.method === "POST") {
        const payload = (await request.clone().json()) as { id?: unknown; method?: unknown };
        if (payload.method === "tools/call") {
          toolCallIds.push(payload.id);
        }
      }

      return fetch(request);
    };

    const heartRateClient = new Client({ name: "heart-rate-test", version: "1.0.0" });
    const temperatureClient = new Client({ name: "temperature-test", version: "1.0.0" });
    const heartRateTransport = new StreamableHTTPClientTransport(endpoint, { fetch: captureFetch });
    const temperatureTransport = new StreamableHTTPClientTransport(endpoint, { fetch: captureFetch });

    await Promise.all([heartRateClient.connect(heartRateTransport), temperatureClient.connect(temperatureTransport)]);
    const [heartRateResult, temperatureResult] = await Promise.all([
      heartRateClient.callTool({ arguments: { dataTypes: ["heart_rate"] }, name: "solid_fetch_vitals" }),
      temperatureClient.callTool({ arguments: { dataTypes: ["temperature"] }, name: "solid_fetch_vitals" }),
    ]);

    expect(toolCallIds).toHaveLength(2);
    expect(toolCallIds[0]).toBeDefined();
    expect(toolCallIds[0]).toBe(toolCallIds[1]);
    expect(((heartRateResult as CallToolResult).structuredContent as { records: Array<{ type: string }> }).records.map((record) => record.type)).toEqual(
      ["heart_rate"],
    );
    expect(
      ((temperatureResult as CallToolResult).structuredContent as { records: Array<{ type: string }> }).records.map((record) => record.type),
    ).toEqual(["temperature"]);

    await Promise.all([heartRateClient.close(), temperatureClient.close()]);
  });
});
