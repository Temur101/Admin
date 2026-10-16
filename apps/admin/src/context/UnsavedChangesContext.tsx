import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useBeforeUnload, useBlocker } from "react-router-dom";
import { Modal } from "../components/common/Modal.js";
import { Button } from "../components/common/Button.js";

const UnsavedChangesContext = createContext<{
  dirty: boolean;
  register: (scope: string, dirty: boolean) => void;
  confirmDiscard: () => boolean;
} | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [scopes, setScopes] = useState<Record<string, boolean>>({});
  const dirty = Object.values(scopes).some(Boolean);
  const blocker = useBlocker(dirty);
  const register = useCallback((scope: string, value: boolean) => {
    setScopes((previous) =>
      previous[scope] === value ? previous : { ...previous, [scope]: value },
    );
  }, []);
  const confirmDiscard = useCallback(
    () => !dirty || window.confirm("Есть несохранённые изменения. Выйти и потерять их?"),
    [dirty],
  );
  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (dirty) {
          event.preventDefault();
          event.returnValue = "";
        }
      },
      [dirty],
    ),
  );
  const value = useMemo(
    () => ({ dirty, register, confirmDiscard }),
    [dirty, register, confirmDiscard],
  );

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      <Modal
        isOpen={blocker.state === "blocked"}
        title="Изменения не сохранены"
        description="Вернитесь в редактор и сохраните изменения перед выходом."
        onClose={() => blocker.state === "blocked" && blocker.reset()}
      >
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => blocker.state === "blocked" && blocker.reset()}>
            Остаться
          </Button>
          <Button variant="danger" onClick={() => blocker.state === "blocked" && blocker.proceed()}>
            Уйти без сохранения
          </Button>
        </div>
      </Modal>
    </UnsavedChangesContext.Provider>
  );
}

export function useDiscardConfirmation() {
  const context = useContext(UnsavedChangesContext);
  if (!context) throw new Error("UnsavedChangesProvider is required");
  return context.confirmDiscard;
}

export function useUnsavedChanges(scope: string, dirty: boolean) {
  const context = useContext(UnsavedChangesContext);
  if (!context) throw new Error("UnsavedChangesProvider is required");
  const { register } = context;
  useEffect(() => {
    register(scope, dirty);
    return () => register(scope, false);
  }, [scope, dirty, register]);
}

export function useHasUnsavedChanges(): boolean {
  const context = useContext(UnsavedChangesContext);
  if (!context) throw new Error("UnsavedChangesProvider is required");
  return context.dirty;
}
