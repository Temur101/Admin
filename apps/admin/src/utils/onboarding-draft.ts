import type { BotType, ResourceType } from "@lcqb/contracts";

export interface CreationDraft {
  step: number;
  clientMode: "existing" | "new";
  tenantId: string;
  clientName: string;
  contactPhone: string;
  botType: BotType;
  templateId: string;
  resourceType: ResourceType;
  createdBotId?: string;
}
export function newCreationDraft(): CreationDraft {
  return {
    step: 0,
    clientMode: "existing",
    tenantId: "",
    clientName: "",
    contactPhone: "",
    botType: "LEADCATCH",
    templateId: "",
    resourceType: "STAFF",
    createdBotId: undefined,
  };
}
export function creationDraftKey(scope: string) {
  return `lcqb:onboarding:${scope}`;
}
export function readCreationDraft(scope?: string): CreationDraft {
  if (!scope) return newCreationDraft();
  try {
    const raw = JSON.parse(localStorage.getItem(creationDraftKey(scope)) || "null");
    if (!raw || raw.version !== 1) return newCreationDraft();
    const draft = raw.draft as Partial<CreationDraft>;
    if (
      ![0, 1, 2].includes(draft.step ?? -1) ||
      !["LEADCATCH", "QUICKBOOK"].includes(draft.botType ?? "") ||
      !["STAFF", "TABLE", "ROOM"].includes(draft.resourceType ?? "")
    )
      return newCreationDraft();
    if (!["existing", "new"].includes(draft.clientMode ?? "")) return newCreationDraft();
    if (
      [draft.tenantId, draft.clientName, draft.contactPhone, draft.templateId].some(
        (value) => typeof value !== "string",
      )
    )
      return newCreationDraft();
    if (draft.step! > 0 && !draft.tenantId) return newCreationDraft();
    if (draft.createdBotId !== undefined && typeof draft.createdBotId !== "string")
      return newCreationDraft();
    return {
      step: draft.step!,
      clientMode: draft.clientMode!,
      tenantId: draft.tenantId!,
      clientName: draft.clientName!,
      contactPhone: draft.contactPhone!,
      botType: draft.botType!,
      templateId: draft.templateId!,
      resourceType: draft.resourceType!,
      createdBotId: draft.createdBotId,
    };
  } catch {
    return newCreationDraft();
  }
}
export function saveCreationDraft(scope: string | undefined, draft: CreationDraft): boolean {
  if (!scope) return true;
  try {
    // Explicit allowlist: tokens and passwords never enter browser storage.
    const {
      step,
      clientMode,
      tenantId,
      clientName,
      contactPhone,
      botType,
      templateId,
      resourceType,
      createdBotId,
    } = draft;
    localStorage.setItem(
      creationDraftKey(scope),
      JSON.stringify({
        version: 1,
        draft: {
          step,
          clientMode,
          tenantId,
          clientName,
          contactPhone,
          botType,
          templateId,
          resourceType,
          createdBotId,
        },
      }),
    );
    return true;
  } catch {
    return false;
  }
}
export function setupProgressKey(scope: string, botId: string) {
  return `lcqb:setup:${scope}:${botId}`;
}
export function readSetupStep(scope: string | undefined, botId: string): number {
  if (!scope) return 3;
  try {
    const value = Number(localStorage.getItem(setupProgressKey(scope, botId)));
    return [3, 4, 5].includes(value) ? value : 3;
  } catch {
    return 3;
  }
}
export function saveSetupStep(scope: string | undefined, botId: string, step: number) {
  if (!scope) return;
  try {
    localStorage.setItem(setupProgressKey(scope, botId), String(step));
  } catch {
    /* The bot and saved settings remain on the server. */
  }
}
