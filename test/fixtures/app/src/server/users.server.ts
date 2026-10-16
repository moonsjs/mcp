import { serverFn } from "@moonsjs/server";
import { z } from "zod";

export const getUser = serverFn({
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string(), name: z.string() }),
  handler: async ({ input }) => ({ id: input.id, name: "fixture" }),
});
