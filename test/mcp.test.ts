import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { getRuntimeConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";
import { MemoryWaitlistStore } from "../src/waitlist.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe("mcp", () => {
  test("supports Streamable HTTP listTools and tool calls with the official client", async () => {
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

    const client = new Client({ name: "medlock-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("/api/mcp", server.url));

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["solid_fetch_vitals", "vitals_scan"]);

    const result = (await client.callTool({
      arguments: { dataTypes: ["heart_rate"] },
      name: "solid_fetch_vitals",
    })) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.source).toBe("demo-solid-pod");
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
});
