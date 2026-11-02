import { defineConfig } from "vitest/config";

// Plain Node config: the unit tests cover pure modules, so they skip the Workers vite plugins.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] }
});
