import { LogOut, ShieldCheck, User } from "lucide-react";
import { useAuth } from "../../context/AuthContext.js";

export function TopBar() {
  const { user, logout } = useAuth();

  return (
    <header className="h-16 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-8 shrink-0">
      <div className="flex items-center gap-3">
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span>Система активна</span>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5 text-xs text-slate-300 bg-slate-800/60 px-3 py-1.5 rounded-xl border border-slate-700/60">
          <div className="h-6 w-6 rounded-lg bg-indigo-600/20 text-indigo-400 flex items-center justify-center">
            {user?.role === "SUPERADMIN" ? <ShieldCheck className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
          </div>
          <div>
            <p className="font-semibold text-white leading-tight">{user?.name || "Супер-Администратор"}</p>
            <p className="text-[10px] text-slate-400 leading-tight">{user?.email}</p>
          </div>
        </div>

        <button
          onClick={() => void logout()}
          title="Выйти из системы"
          className="p-2 rounded-xl text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition-all cursor-pointer"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
