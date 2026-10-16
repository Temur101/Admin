import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "./apps/admin/test/environment.ts",
    include: [
      "apps/admin/test/**/*.test.{ts,tsx}",
      "apps/server/test/bot-connection.test.ts",
      "apps/server/test/leadcatch-dag.test.ts",
      "apps/server/test/editor-settings.test.ts",
      "apps/server/test/bot-setup.test.ts",
      "apps/server/test/bots-launch.test.ts",
      "apps/server/test/bot-empty-flow.test.ts",
      "apps/server/test/quickbook-slots.test.ts",
    ],
    restoreMocks: true,
  },
});
