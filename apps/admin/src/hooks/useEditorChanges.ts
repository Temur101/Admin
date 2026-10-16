import { useState } from "react";
import { useUnsavedChanges } from "../context/UnsavedChangesContext.js";
import { editorSnapshot } from "../utils/editor-state.js";

export function useEditorChanges(
  scope: string,
  config: unknown,
  jsonText: string,
  mode: "visual" | "json",
) {
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(config));
  const dirty = editorSnapshot(config, jsonText, mode) !== savedSnapshot;
  useUnsavedChanges(scope, dirty);
  return { dirty, markSaved: (settings: unknown) => setSavedSnapshot(JSON.stringify(settings)) };
}
