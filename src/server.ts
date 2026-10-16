import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createTools, type ToolsetOptions } from "./tools";

function jsonContent(value: unknown, isError = false): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function guard(
  run: () => Promise<unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    return jsonContent(await run());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonContent({ ok: false, error: message }, true);
  }
}

/** Bangun MCP server `moons` (stdio) untuk satu project (Addendum A.7). */
export function createMcpServer(options: ToolsetOptions): McpServer {
  const tools = createTools(options);
  const server = new McpServer({ name: "moons", version: "0.1.0" });

  server.registerTool(
    "list_routes",
    {
      description:
        "Route table of the Moons app (path, file, key, kind, params, layouts) — scanned, no build needed.",
    },
    () => guard(() => tools.listRoutes()),
  );

  server.registerTool(
    "get_fn_registry",
    {
      description:
        "serverFn registry of the Moons app (file#export → hash, line) plus the registry map written to .moons/fn-registry.json.",
    },
    () => guard(() => tools.getFnRegistry()),
  );

  server.registerTool(
    "run_check",
    {
      description:
        "Definition of done: typegen → tsc --noEmit → build client → build server. Returns { ok, steps }.",
    },
    () => guard(() => tools.runCheck()),
  );

  server.registerTool(
    "search_docs",
    {
      description:
        "Search the Moons agent context pack (docs/ai/CONTEXT.md) by substring; returns matching lines with their sections.",
      inputSchema: { query: z.string().describe("substring to search (case-insensitive)") },
    },
    ({ query }) => guard(() => tools.searchDocs(query)),
  );

  server.registerTool(
    "audit",
    {
      description:
        "Security audit: serverFn inventory, env() access map, cookie flags, CSP, and a dist/client scan for env-like secrets (Addendum H).",
    },
    () => guard(() => tools.audit()),
  );

  server.registerTool(
    "run_typegen",
    {
      description:
        "Run typegen: writes .moons/routes.d.ts + .moons/context.d.ts for the app in cwd.",
    },
    () => guard(() => tools.runTypegen()),
  );

  server.registerTool(
    "explain_error",
    {
      description:
        "Explain a Moons error code (format [moons] E_...): trigger, details, and fix suggestions. Returns found=false + validCodes for unknown codes.",
      inputSchema: { code: z.string().describe("error code, e.g. E_SERVER_IMPORT_IN_CLIENT") },
    },
    ({ code }) => guard(() => tools.explainError(code)),
  );

  return server;
}
