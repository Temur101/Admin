import { QuickBookConfigSchema, type QuickBookConfig } from "@lcqb/contracts";
import { DEFAULT_QUICKBOOK_CONFIG } from "./default-config.js";

export function getQuickBookConfig(settings?: Record<string, unknown> | null): QuickBookConfig {
  if (!settings) {
    return DEFAULT_QUICKBOOK_CONFIG;
  }

  const rawConfig = settings.quickbook ?? settings;
  const parsed = QuickBookConfigSchema.safeParse(rawConfig);
  if (parsed.success) {
    return parsed.data;
  }

  return DEFAULT_QUICKBOOK_CONFIG;
}
