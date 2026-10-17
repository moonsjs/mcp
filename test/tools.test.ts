import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server";
import { createTools, localContextPath, searchMarkdown, CONTEXT_URLS } from "../src/tools";

// Fixture mandiri di dalam repo (bukan paths monorepo) — repo paket berdiri sendiri.
const fixtures = join(import.meta.dir, "fixtures");

test("CONTEXT_URLS: situs docs dulu, lalu GitHub raw (mirror)", () => {
  expect(CONTEXT_URLS).toHaveLength(2);
  expect(CONTEXT_URLS[0]).toContain("docs.devmoon.net/raw/ai/CONTEXT.md");
  expect(CONTEXT_URLS[1]).toContain("raw.githubusercontent.com/moonsjs/docs");
});

test("localContextPath: menghitung docs/ai dari entry paket @moonsjs/cli", () => {
  expect(localContextPath("/x/node_modules/@moonsjs/cli/dist/index.js")).toBe(
    "/x/node_modules/@moonsjs/cli/docs/ai/CONTEXT.md",
  );
  expect(localContextPath("/y/node_modules/@moonsjs/cli/src/index.ts")).toBe(
    "/y/node_modules/@moonsjs/cli/docs/ai/CONTEXT.md",
  );
});

test("searchMarkdown: menemukan baris + section terakhir", () => {
  const markdown = [
    "# Title",
    "",
    "## Routing",
    "index.tsx maps to /",
    "### Details",
    "dynamic [id] segments",
  ].join("\n");

  const matches = searchMarkdown(markdown, "[id]");
  expect(matches).toEqual([{ section: "Details", line: 6, text: "dynamic [id] segments" }]);
  expect(searchMarkdown(markdown, "MAPS TO")).toHaveLength(1);
  expect(searchMarkdown(markdown, "")).toEqual([]);
});

test("listRoutes/getFnRegistry: membaca contoh nyata via @moonsjs/cli", async () => {
  const app = createTools({ cwd: join(fixtures, "app"), fetchContext: async () => "" });
  const routes = await app.listRoutes();
  expect(routes.routes.some((route) => route.key === "notes/[id]")).toBe(true);

  const fns = await app.getFnRegistry();
  expect(fns.registry["src/server/users.server.ts#getUser"]).toBe("0b86453c274ba6fc");
});

test("searchDocs: fetcher disuntik + hasil di-cache sekali", async () => {
  let calls = 0;
  const tools = createTools({
    cwd: fixtures,
    fetchContext: async () => {
      calls += 1;
      return "# Context\n\n## Secrets\nenv() only in *.server.ts\n";
    },
  });

  const first = await tools.searchDocs("env()");
  const second = await tools.searchDocs(".server");
  expect(first.matches[0]?.section).toBe("Secrets");
  expect(first.matches[0]?.line).toBe(4);
  expect(second.matches.length).toBeGreaterThan(0);
  expect(calls).toBe(1);
});

test("MCP end-to-end in-memory: 9 tool terdaftar + list_routes + explain_error", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    cwd: join(fixtures, "app"),
    fetchContext: async () => "# Context\n",
  });
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const listed = await client.listTools();
  expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
    "audit",
    "explain_error",
    "get_fn_registry",
    "list_routes",
    "run_check",
    "run_typegen",
    "scaffold_route",
    "search_docs",
    "tail_dev_logs",
  ]);

  const typegen = await client.callTool({ name: "run_typegen", arguments: {} });
  const typegenContent = typegen.content as Array<{ type: string; text?: string }>;
  expect(typegenContent[0]?.text ?? "").toContain('"ok": true');

  const result = await client.callTool({ name: "list_routes", arguments: {} });
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(content[0]?.type).toBe("text");
  expect(content[0]?.text ?? "").toContain("notes/[id]");

  const explained = await client.callTool({
    name: "explain_error",
    arguments: { code: "e_schema_local_ref" },
  });
  const explainContent = explained.content as Array<{ type: string; text?: string }>;
  const parsed = JSON.parse(explainContent[0]?.text ?? "{}") as {
    found: boolean;
    entry?: { code: string; suggestions: string[] };
  };
  expect(parsed.found).toBe(true);
  expect(parsed.entry?.code).toBe("E_SCHEMA_LOCAL_REF");
  expect(parsed.entry?.suggestions.length ?? 0).toBeGreaterThan(0);

  await client.close();
  await server.close();
});

function tempApp(): string {
  return mkdtempSync(join(tmpdir(), "moons-mcp-tools-"));
}

test("L.4 scaffoldRoute: page + loader dibuat; tolak timpa & segmen invalid", async () => {
  const cwd = tempApp();
  const tools = createTools({ cwd });

  const created = await tools.scaffoldRoute({ route: "/orders/[id]", loader: true });
  expect(created.file).toBe("src/routes/orders/[id].tsx");
  const content = readFileSync(join(cwd, created.file), "utf8");
  expect(content).toContain("useLoaderData");
  expect(content).toContain("export const loader");

  await expect(tools.scaffoldRoute({ route: "orders/[id]" })).rejects.toThrow("already exists");
  await expect(tools.scaffoldRoute({ route: "../evil" })).rejects.toThrow("invalid route segment");
  await expect(tools.scaffoldRoute({ route: "" })).rejects.toThrow("must not be empty");

  const api = await tools.scaffoldRoute({ route: "webhooks/stripe", kind: "api" });
  expect(api.file).toBe("src/api/webhooks/stripe.ts");
  expect(readFileSync(join(cwd, api.file), "utf8")).toContain("ApiHandlerArgs");
});

test("L.4 tailDevLogs: missing → exists false; isi → N baris terakhir", async () => {
  const cwd = tempApp();
  const tools = createTools({ cwd });

  const missing = await tools.tailDevLogs(10);
  expect(missing.exists).toBe(false);
  expect(missing.file).toBe(".moons/dev.log");
  expect(missing.text).toContain("no dev log yet");

  mkdirSync(join(cwd, ".moons"), { recursive: true });
  writeFileSync(join(cwd, ".moons", "dev.log"), "a\nb\nc\n");
  const tail = await tools.tailDevLogs(2);
  expect(tail.exists).toBe(true);
  expect(tail.text).toBe("b\nc");
});
