import { apiRequest } from "./client.js";

export interface TemplateMeta {
  id: string;
  name: string;
  description: string;
  botType: "LEADCATCH" | "QUICKBOOK";
}

export async function getTemplates(): Promise<TemplateMeta[]> {
  const data = await apiRequest<{ ok: true; templates: TemplateMeta[] }>("/api/v1/templates");
  return data.templates;
}

export async function applyTemplate(botId: string, templateId: string): Promise<unknown> {
  const data = await apiRequest<{ ok: true; settings: unknown }>(`/api/v1/bots/${botId}/apply-template`, {
    method: "POST",
    body: JSON.stringify({ templateId }),
  });
  return data.settings;
}

export async function updateBotSettings(botId: string, settings: unknown): Promise<unknown> {
  const data = await apiRequest<{ ok: true; settings: unknown }>(`/api/v1/bots/${botId}/settings`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
  return data.settings;
}
