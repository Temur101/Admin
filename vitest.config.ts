import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 20000,
    poolOptions: {
      forks: {
        execArgv: ["--expose-gc"],
      },
    },
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});

