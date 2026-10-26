import { LogOut, ShieldCheck, Menu } from "lucide-react";
import { useAuth } from "../../context/AuthContext.js";

import { useDiscardConfirmation } from "../../context/UnsavedChangesContext.js";

export function TopBar({ onMenuClick }: { onMenuClick: () => void }) {
  const { user, logout } = useAuth();
  const confirmDiscard = useDiscardConfirmation();

  return (
    <header className="h-16 bg-ui-surface border-b border-ui-border flex items-center justify-between px-4 sm:px-6 xl:px-8 shrink-0">
      <div className="flex items-center gap-3">
        <button
          aria-label="Открыть меню"
          onClick={onMenuClick}
          className="p-2 text-ui-secondary rounded-lg hover:bg-ui-hover lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="text-sm font-medium text-ui-secondary hidden sm:block">
          Панель управления
        </span>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5 text-sm text-ui-secondary bg-ui-hover px-3 py-1.5 rounded-xl border border-ui-border">
          <div className="h-6 w-6 rounded-lg bg-ui-accent-soft text-ui-accent flex items-center justify-center">
            <ShieldCheck className="h-3.5 w-3.5" />
          </div>
          <div>
            <p className="font-semibold text-ui-text leading-tight">
              {user?.name || "Супер-Администратор"}
            </p>
            <p className="text-xs text-ui-muted leading-tight truncate max-w-44">{user?.email}</p>
          </div>
        </div>

        <button
          onClick={() => {
            if (confirmDiscard()) void logout();
          }}
          title="Выйти из системы"
          className="p-2 rounded-xl text-ui-muted hover:text-ui-danger hover:bg-ui-danger-soft border border-transparent hover:border-ui-danger-border transition-all cursor-pointer"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
