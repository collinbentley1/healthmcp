import type { AuthInfo, CallToolResult } from "@modelcontextprotocol/server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { RuntimeConfig } from "./config.ts";
import { isTrustedHost, isTrustedOrigin, json, withCors } from "./http.ts";
import { fetchDemoVitals, VITAL_TYPES } from "./vitals.ts";

export type McpEndpoint = {
  readonly handle: (request: Request) => Promise<Response>;
};

const vitalTypeSchema = z.enum(VITAL_TYPES);
const MAX_MCP_BODY_SIZE = 65_536;
const dateRangeSchema = z
  .object({
    end: z.string().datetime().optional().describe("Inclusive ISO 8601 end timestamp."),
    start: z.string().datetime().optional().describe("Inclusive ISO 8601 start timestamp."),
  })
  .optional();

const vitalReadingSchema = z.object({
  confidence: z.number().min(0).max(1),
  displayName: z.string(),
  observedAt: z.string().datetime(),
  source: z.string(),
  type: vitalTypeSchema,
  unit: z.string(),
  value: z.string(),
});

const fetchVitalsOutputSchema = z.object({
  audit: z.object({
    clientId: z.string(),
    readOnly: z.literal(true),
    tool: z.literal("solid_fetch_vitals"),
  }),
  records: z.array(vitalReadingSchema),
  source: z.literal("demo-solid-pod"),
});

const scanOutputSchema = z.object({
  device: z.enum(["front", "rear"]),
  instructions: z.array(z.string()),
  privacyMode: z.literal("local-first"),
  scanUrl: z.string(),
  status: z.literal("ready"),
  supportedMeasurements: z.array(vitalTypeSchema),
});

type FetchVitalsOutput = z.infer<typeof fetchVitalsOutputSchema>;
type ScanOutput = z.infer<typeof scanOutputSchema>;

export function createMcpEndpoint(config: RuntimeConfig): McpEndpoint {
  const handler = createMcpHandler(() => createMedlockMcpServer(config), {
    onerror: (error) => console.error("mcp request failed", error.name),
  });

  return {
    async handle(request: Request): Promise<Response> {
      if (!isTrustedHost(request, config)) {
        return withCors(json({ error: "untrusted host" }, { status: 403 }), request, config);
      }

      if (!isTrustedOrigin(request, config)) {
        return withCors(json({ error: "untrusted origin" }, { status: 403 }), request, config);
      }

      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }), request, config);
      }

      if (request.method !== "POST") {
        return withCors(
          json({ error: "method not allowed" }, { headers: { Allow: "POST, OPTIONS" }, status: 405 }),
          request,
          config,
        );
      }

      const mediaType = (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        return withCors(json({ error: "expected application/json" }, { status: 415 }), request, config);
      }

      const authInfo = authenticate(request, config);
      if (!authInfo) {
        return withCors(
          json(
            { error: "missing or invalid bearer token" },
            { headers: { "WWW-Authenticate": 'Bearer realm="medlock-mcp"' }, status: 401 },
          ),
          request,
          config,
        );
      }

      const parsedBody = await readBoundedJson(request.clone(), MAX_MCP_BODY_SIZE);
      if (parsedBody.kind === "too-large") {
        return withCors(json({ error: "request body too large" }, { status: 413 }), request, config);
      }

      if (parsedBody.kind === "invalid") {
        return withCors(json({ error: "invalid JSON body" }, { status: 400 }), request, config);
      }

      if (Array.isArray(parsedBody.value)) {
        return withCors(json({ error: "JSON-RPC batches are not supported" }, { status: 400 }), request, config);
      }

      return withCors(await handler.fetch(request, { authInfo, parsedBody: parsedBody.value }), request, config);
    },
  };
}

function createMedlockMcpServer(config: RuntimeConfig): McpServer {
  const server = new McpServer(
    {
      name: "medlock",
      version: config.version,
      websiteUrl: "https://medlock.ai",
    },
    {
      instructions:
        "Medlock exposes a privacy-preserving health-data MCP surface. This deployment uses demo Solid Pod data until a user connects their own pod; never treat returned readings as medical advice.",
    },
  );

  registerMedlockTools(server, config);
  return server;
}

function registerMedlockTools(server: McpServer, config: RuntimeConfig): void {
  server.registerTool(
    "solid_fetch_vitals",
    {
      annotations: {
        openWorldHint: false,
        readOnlyHint: true,
        title: "Fetch Solid Pod vitals",
      },
      description: "Fetch selected vitals from the user's connected Solid Pod. The current open-source deployment returns deterministic demo readings.",
      inputSchema: z.object({
        dataTypes: z.array(vitalTypeSchema).min(1).max(VITAL_TYPES.length).default([...VITAL_TYPES]),
        dateRange: dateRangeSchema,
      }),
      outputSchema: fetchVitalsOutputSchema,
      title: "Fetch vitals",
    },
    async ({ dataTypes, dateRange }, ctx): Promise<CallToolResult> => {
      const clientId = ctx.http?.authInfo?.clientId ?? "anonymous-demo";
      const output: FetchVitalsOutput = {
        audit: {
          clientId,
          readOnly: true,
          tool: "solid_fetch_vitals",
        },
        records: fetchDemoVitals(dataTypes, dateRange),
        source: "demo-solid-pod",
      };

      await ctx.mcpReq.log("info", {
        clientId,
        recordCount: output.records.length,
        tool: "solid_fetch_vitals",
      });

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: { ...output },
      };
    },
  );

  server.registerTool(
    "vitals_scan",
    {
      annotations: {
        openWorldHint: false,
        readOnlyHint: true,
        title: "Prepare vitals scan",
      },
      description:
        "Prepare a browser-based vitals scan handoff. The tool returns instructions and a URL; it never activates camera hardware from the MCP server.",
      inputSchema: z.object({
        device: z.enum(["front", "rear"]).default("front"),
      }),
      outputSchema: scanOutputSchema,
      title: "Prepare vitals scan",
    },
    async ({ device }): Promise<CallToolResult> => {
      const output: ScanOutput = {
        device,
        instructions: [
          "Open the scan URL in a trusted browser session.",
          "Grant camera access only after the browser explains the local processing flow.",
          "Keep your finger still over the camera lens until the quality indicator is stable.",
        ],
        privacyMode: "local-first",
        scanUrl: `https://${config.canonicalHost}/scan?device=${device}`,
        status: "ready",
        supportedMeasurements: ["heart_rate", "blood_oxygen", "respiratory_rate"],
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: { ...output },
      };
    },
  );

  server.registerResource(
    "medlock-context",
    "medlock://context",
    {
      description: "Deployment and safety context for Medlock clients.",
      mimeType: "application/json",
      title: "Medlock context",
    },
    async (uri) => ({
      contents: [
        {
          mimeType: "application/json",
          text: JSON.stringify(
            {
              canonicalHost: config.canonicalHost,
              healthDataMode: "demo-solid-pod",
              mcpTransport: "streamable-http",
              productionNotice: "Connect real Solid Pods only through a private deployment with MEDLOCK_MCP_TOKEN configured.",
            },
            null,
            2,
          ),
          uri: uri.href,
        },
      ],
    }),
  );
}

function authenticate(request: Request, config: RuntimeConfig): AuthInfo | undefined {
  if (!config.mcpBearerToken) {
    return {
      clientId: "anonymous-demo",
      scopes: ["demo:read"],
      token: "anonymous-demo",
    };
  }

  const authorization = request.headers.get("authorization")?.trim();
  const expected = `Bearer ${config.mcpBearerToken}`;

  if (authorization !== expected) {
    return undefined;
  }

  return {
    clientId: "bearer-client",
    scopes: ["pod:read", "scan:prepare"],
    token: config.mcpBearerToken,
  };
}

type BoundedJsonResult =
  | { readonly kind: "invalid" }
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "too-large" };

async function readBoundedJson(request: Request, maxBytes: number): Promise<BoundedJsonResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      return { kind: "invalid" };
    }
    if (declaredBytes > maxBytes) {
      return { kind: "too-large" };
    }
  }

  if (!request.body) {
    return { kind: "invalid" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too-large" };
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: "ok", value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { kind: "invalid" };
  }
}
