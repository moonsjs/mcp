import { defineConfig } from "@moonsjs/core";

export default defineConfig({
  routesDir: "src/routes",
  context: async () => ({ requestId: "fixture" }),
});
