import type { QuickBookConfig, QuizConfig } from "@lcqb/contracts";
import { LEADCATCH_TEMPLATES } from "./templates-leadcatch.js";
import { QUICKBOOK_TEMPLATES } from "./templates-quickbook.js";

export interface BotTemplateMeta {
  id: string;
  name: string;
  description: string;
  botType: "LEADCATCH" | "QUICKBOOK";
  config: QuizConfig | QuickBookConfig;
}

export const TEMPLATES_CATALOG: BotTemplateMeta[] = [
  ...LEADCATCH_TEMPLATES,
  ...QUICKBOOK_TEMPLATES,
];
