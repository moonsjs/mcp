import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_VERSION } from "./version";
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
  const server = new McpServer({ name: "moons", version: MCP_VERSION });

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
    "diagnose",
    {
      description:
        "Diagnose the app: moons.config.ts loads, @moonsjs/* versions, duplicate/nested framework copies, peer packages, typegen freshness, and port availability (Addendum P).",
    },
    () => guard(() => tools.diagnose()),
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
    "scaffold_route",
    {
      description:
        "Create a route file following Moons conventions: page → src/routes/<route>.tsx (default export + optional loader), api → src/api/<route>.ts (GET handler). Never overwrites existing files (Addendum L.4).",
      inputSchema: {
        route: z.string().describe('route path without extension, e.g. "orders/[id]"'),
        kind: z.enum(["page", "api"]).optional().describe("default: page"),
        loader: z
          .boolean()
          .optional()
          .describe("page only: include a sample loader + useLoaderData"),
      },
    },
    ({ route, kind, loader }) =>
      guard(() =>
        tools.scaffoldRoute({
          route,
          ...(kind === undefined ? {} : { kind }),
          ...(loader === undefined ? {} : { loader }),
        }),
      ),
  );

  server.registerTool(
    "tail_dev_logs",
    {
      description:
        "Tail the CLI-managed dev log (.moons/dev.log written by `moons dev`); default 50 lines, max 500 (Addendum L.4).",
      inputSchema: {
        lines: z.number().int().min(1).max(500).optional().describe("default 50"),
      },
    },
    ({ lines }) => guard(() => tools.tailDevLogs(lines ?? 50)),
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
