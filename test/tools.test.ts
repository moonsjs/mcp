import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { join } from "node:path";
import { createMcpServer } from "../src/server";
import { createTools, localContextPath, searchMarkdown, CONTEXT_URLS } from "../src/tools";

// Fixture mandiri di dalam repo (bukan paths monorepo) — repo paket berdiri sendiri.
const fixtures = join(import.meta.dir, "fixtures");

test("CONTEXT_URLS: situs docs dulu, lalu pages.dev, lalu GitHub raw (mirror)", () => {
  expect(CONTEXT_URLS[0]).toContain("docs.devmoon.net");
  expect(CONTEXT_URLS[1]).toContain("moonsjs-docs.pages.dev");
  expect(CONTEXT_URLS[2]).toContain("raw.githubusercontent.com/moonsjs/docs");
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

test("MCP end-to-end in-memory: 5 tool terdaftar + list_routes + explain_error", async () => {
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
    "explain_error",
    "get_fn_registry",
    "list_routes",
    "run_check",
    "search_docs",
  ]);

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
