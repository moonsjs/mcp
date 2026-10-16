import { MOONS_ERROR_CODES, findErrorEntry, type ErrorCatalogEntry } from "@moonsjs/core";
import {
  collectFns,
  collectRoutes,
  executeCheck,
  type CheckJson,
  type FnsJson,
  type RoutesJson,
} from "@moonsjs/cli";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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
  };
}
