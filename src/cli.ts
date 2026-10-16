#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";

const server = createMcpServer({ cwd: process.cwd() });
await server.connect(new StdioServerTransport());
