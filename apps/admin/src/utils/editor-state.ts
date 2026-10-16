export function editorSnapshot(config: unknown, jsonText: string, mode: "visual" | "json"): string {
  if (mode === "visual") return JSON.stringify(config);
  try {
    return JSON.stringify(JSON.parse(jsonText));
  } catch {
    return `invalid-json:${jsonText}`;
  }
}
