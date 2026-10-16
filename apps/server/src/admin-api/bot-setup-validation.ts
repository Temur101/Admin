import type { BotType } from "@lcqb/contracts";
import { quizSetupIssues, bookingSetupIssues } from "@lcqb/contracts/validation";
export function validateBotSetup(botType: BotType, settings: unknown): string[] {
  const wrapped = settings as { quickbook?: unknown; quiz?: unknown } | null;
  return botType === "LEADCATCH"
    ? quizSetupIssues(wrapped?.quiz ?? settings)
    : bookingSetupIssues(wrapped?.quickbook ?? settings);
}
