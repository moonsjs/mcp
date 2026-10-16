import { MOONS_ERROR_CODES, findErrorEntry, type ErrorCatalogEntry } from "@moonsjs/core";
import {
  collectFns,
  collectRoutes,
  executeAudit,
  executeCheck,
  runTypegen,
  type AuditJson,
  type CheckJson,
  type FnsJson,
  type RoutesJson,
} from "@moonsjs/cli";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";

/** Sumber teks konteks framework (default: lokal dulu, lalu GitHub raw). */
export type ContextFetcher = () => Promise<string>;

 export const CONTEXT_URL =
  "https://raw.githubusercontent.com/moonsjs/docs/main/ai/CONTEXT.md";

/** Rantai fallback remote: situs docs → pages.dev → GitHub raw (repo docs). */
export const CONTEXT_URLS: readonly string[] = [
  "https://docs.devmoon.net/raw/ai/CONTEXT.md",
  "https://moonsjs-docs.pages.dev/raw/ai/CONTEXT.md",
  CONTEXT_URL,
];

/** Path konteks offline di paket `@moonsjs/cli`, dari entry yang di-resolve. */
export function localContextPath(cliEntry: string): string {
  return join(dirname(cliEntry), "..", "docs", "ai", "CONTEXT.md");
}

function readLocalContext(): { source: string; text: string } | null {
  try {
    const entry = createRequire(import.meta.url).resolve("@moonsjs/cli");
    const path = localContextPath(entry);
    if (existsSync(path)) {
      return { source: `local:${path}`, text: readFileSync(path, "utf8") };
    }
  } catch {
    // fallthrough ke remote
  }
  return null;
}

async function defaultLoadContext(): Promise<{ source: string; text: string }> {
  const local = readLocalContext();
  if (local !== null) {
    return local;
  }
  let lastError: unknown = null;
  for (const url of CONTEXT_URLS) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return { source: url, text: await response.text() };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `gagal mengambil konteks dari ${CONTEXT_URLS.join(" dan ")}: ${String(lastError)}`,
  );
}

export interface DocMatch {
  /** Judul section terakhir sebelum baris ini. */
  section: string;
  /** Nomor baris (1-based) di CONTEXT.md. */
  line: number;
  text: string;
}

export interface SearchDocsResult {
  source: string;
  query: string;
  matches: DocMatch[];
}

export interface ExplainErrorResult {
  code: string;
  found: boolean;
  entry?: ErrorCatalogEntry;
  validCodes: string[];
}

export interface Toolset {
  listRoutes: () => Promise<RoutesJson>;
  getFnRegistry: () => Promise<FnsJson>;
  runCheck: () => Promise<CheckJson>;
  searchDocs: (query: string) => Promise<SearchDocsResult>;
  /** Addendum B.6: kode error §15 → pemicu + saran. */
  explainError: (code: string) => Promise<ExplainErrorResult>;
  /** Addendum H: audit keamanan (RPC/env/cookie/CSP/dist) machine-readable. */
  audit: () => Promise<AuditJson>;
  /** Addendum H: jalankan typegen (`.moons/*.d.ts`). */
  runTypegen: () => Promise<{ ok: true; outDir: string }>;
  /** Addendum L.4: buat file route mengikuti konvensi §11 (tanpa menimpa). */
  scaffoldRoute: (input: {
    route: string;
    kind?: "page" | "api";
    loader?: boolean;
  }) => Promise<ScaffoldRouteResult>;
  /** Addendum L.4: baca N baris terakhir `.moons/dev.log` (dikelola `moons dev`). */
  tailDevLogs: (lines: number) => Promise<TailDevLogsResult>;
}

export interface ScaffoldRouteResult {
  file: string;
  kind: "page" | "api";
  created: true;
}

export interface TailDevLogsResult {
  file: string;
  lines: number;
  exists: boolean;
  text: string;
}

export interface ToolsetOptions {
  cwd: string;
  fetchContext?: ContextFetcher;
}

/** Pencarian substring case-insensitive atas markdown; returns baris + section. */
export function searchMarkdown(text: string, query: string, limit = 20): DocMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }

  const lines = text.split("\n");
  const matches: DocMatch[] = [];
  let section = "(top)";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      section = (heading[1] ?? "").trim();
    }
    if (line.toLowerCase().includes(needle)) {
      matches.push({ section, line: index + 1, text: line.trim() });
      if (matches.length >= limit) {
        break;
      }
    }
  }

  return matches;
}

/** Toolset MCP (Addendum A.7) — deterministik, tanpa panggilan LLM. */
export function createTools(options: ToolsetOptions): Toolset {
  const loadContext =
    options.fetchContext === undefined
      ? defaultLoadContext
      : async (): Promise<{ source: string; text: string }> => ({
          source: CONTEXT_URL,
          text: await (options.fetchContext as ContextFetcher)(),
        });
  let cached: { source: string; text: string } | null = null;

  return {
    listRoutes: () => collectRoutes(options.cwd),
    getFnRegistry: () => Promise.resolve(collectFns(options.cwd)),
    runCheck: () => executeCheck(options.cwd, { quiet: true }),
    searchDocs: async (query: string): Promise<SearchDocsResult> => {
      if (cached === null) {
        cached = await loadContext();
      }
      return { source: cached.source, query, matches: searchMarkdown(cached.text, query) };
    },
    explainError: async (code: string): Promise<ExplainErrorResult> => {
      const normalized = code.trim().toUpperCase();
      const entry = findErrorEntry(normalized);
      return {
        code: normalized,
        found: entry !== undefined,
        ...(entry === undefined ? {} : { entry }),
        validCodes: [...MOONS_ERROR_CODES],
      };
    },
    audit: () => executeAudit(options.cwd, { env: process.env }),
    runTypegen: async () => {
      await runTypegen(options.cwd);
      return { ok: true as const, outDir: ".moons" };
    },
    scaffoldRoute: async (input) => {
      const kind = input.kind ?? "page";
      if (kind !== "page" && kind !== "api") {
        throw new Error(`kind tidak dikenal: ${String(kind)}`);
      }
      const route = input.route.trim().replace(/^\/+|\/+$/g, "");
      if (route.length === 0) {
        throw new Error("`route` tidak boleh kosong (contoh: orders/[id])");
      }
      for (const segment of route.split("/")) {
        if (segment.length === 0 || segment === "." || segment === "..") {
          throw new Error(`segmen route tidak valid: \`${segment}\``);
        }
        if (/[\\<>:"|?*]/.test(segment)) {
          throw new Error(`segmen route memuat karakter terlarang: \`${segment}\``);
        }
      }
      const dir = kind === "page" ? "src/routes" : "src/api";
      const ext = kind === "page" ? ".tsx" : ".ts";
      const file = join(options.cwd, dir, `${route}${ext}`);
      const relativeFile = relative(options.cwd, file).split(sep).join("/");
      if (existsSync(file)) {
        throw new Error(`file sudah ada: ${relativeFile} (tidak menimpa)`);
      }
      mkdirSync(dirname(file), { recursive: true });
      const content =
        kind === "page"
          ? renderPageRoute(route, input.loader === true)
          : renderApiRoute(route);
      writeFileSync(file, content);
      return { file: relativeFile, kind, created: true as const };
    },
    tailDevLogs: async (lines) => {
      const clamped = Math.min(Math.max(Math.trunc(lines), 1), 500);
      const file = join(options.cwd, ".moons", "dev.log");
      if (!existsSync(file)) {
        return {
          file: ".moons/dev.log",
          lines: clamped,
          exists: false,
          text: "belum ada log dev — jalankan `moons dev` dulu",
        };
      }
      const text = readFileSync(file, "utf8");
      const all = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
      return {
        file: ".moons/dev.log",
        lines: clamped,
        exists: true,
        text: all.slice(-clamped).join("\n"),
      };
    },
  };
}

/** Template route page (§11): default export + loader opsional. */
function renderPageRoute(route: string, withLoader: boolean): string {
  if (!withLoader) {
    return [
      `// Route: /${route} — dibuat oleh MCP scaffold_route.`,
      "export default function Page() {",
      `  return <p>/${route}</p>;`,
      "}",
      "",
    ].join("\n");
  }
  return [
    `// Route: /${route} — dibuat oleh MCP scaffold_route.`,
    'import { useLoaderData } from "@moonsjs/react";',
    "",
    "export const loader = async () => ({ items: [] as string[] });",
    "",
    "export default function Page() {",
    "  const data = useLoaderData<typeof loader>();",
    "  return <p>{data.items.length} item</p>;",
    "}",
    "",
  ].join("\n");
}

/** Template endpoint API (Addendum D.1): export method + params. */
function renderApiRoute(route: string): string {
  return [
    `// Endpoint: /api/${route} — dibuat oleh MCP scaffold_route.`,
    'import type { ApiHandlerArgs } from "@moonsjs/server";',
    "",
    "export async function GET({ params }: ApiHandlerArgs): Promise<Response> {",
    "  return Response.json({ ok: true, params });",
    "}",
    "",
  ].join("\n");
}
