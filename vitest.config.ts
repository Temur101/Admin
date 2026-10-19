import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 20000,
    fileParallelism: false,
    setupFiles: ["apps/server/test/helpers/test-setup.ts"],
    poolOptions: {
      forks: {
        execArgv: ["--expose-gc"],
      },
    },
    include: ["apps/server/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
