import { useState } from "react";
import {
  readCreationDraft,
  saveCreationDraft,
  type CreationDraft,
} from "../utils/onboarding-draft.js";

export function useCreationDraft(scope?: string) {
  const [draft, setDraft] = useState(() => readCreationDraft(scope));
  const [storageFailed, setStorageFailed] = useState(false);
  const update = (partial: Partial<CreationDraft>) => {
    const next = { ...draft, ...partial };
    setDraft(next);
    setStorageFailed(!saveCreationDraft(scope, next));
    return next;
  };
  return { draft, update, storageFailed };
}
