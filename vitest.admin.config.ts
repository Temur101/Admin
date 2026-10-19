import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "./apps/admin/test/environment.ts",
    include: [
      "apps/admin/test/**/*.test.{ts,tsx}",
      "apps/server/test/bot-connection.test.ts",
      "apps/server/test/quiz-reliability.test.ts",
      "apps/server/test/quiz-text-answer.test.ts",
      "apps/server/test/quiz-text-notification.test.ts",
      "apps/server/test/booking-callbacks.test.ts",
      "apps/server/test/booking-horizon.test.ts",
      "apps/server/test/maintenance.test.ts",
      "apps/server/test/client-navigation.test.ts",
      "apps/server/test/payments-api.test.ts",
      "apps/server/test/receipt-handlers-unit.test.ts",
      "apps/server/test/tariffs-api.test.ts",
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
