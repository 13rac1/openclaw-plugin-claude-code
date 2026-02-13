import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 30000, // 30s timeout for container operations
  },
});
