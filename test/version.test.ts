import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MCP_VERSION } from "../src/version";

test("MCP_VERSION sinkron dengan package.json (anti-drift)", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  expect(MCP_VERSION).toBe(pkg.version);
});
