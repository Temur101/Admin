import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Bot,
  Receipt,
  Settings,
  Sparkles,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getReceipts } from "../../api/receipts.js";

export function Sidebar() {
  const { data: pendingReceipts } = useQuery({
    queryKey: ["pending-receipts-count"],
    queryFn: () => getReceipts("PENDING"),
    refetchInterval: 15000,
  });

  const pendingCount = pendingReceipts?.length ?? 0;

  const links = [
    {
      to: "/dashboard",
      label: "Дашборд",
      icon: LayoutDashboard,
    },
    {
      to: "/tenants",
      label: "Арендаторы",
      icon: Users,
    },
    {
      to: "/bots",
      label: "Боты",
      icon: Bot,
    },
    {
      to: "/receipts",
      label: "Чеки",
      icon: Receipt,
      badge: pendingCount > 0 ? pendingCount : null,
    },
    {
      to: "/settings",
      label: "Настройки",
      icon: Settings,
    },
  ];

  return (
    <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0 min-h-screen">
      <div className="h-16 flex items-center gap-3 px-6 border-b border-slate-800">
        <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-white shadow-md shadow-indigo-500/20">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h1 className="font-bold text-sm tracking-tight text-white">LCQB Platform</h1>
          <p className="text-[10px] font-medium text-slate-400">Telegram SaaS Engine</p>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {links.map((link) => {
          const Icon = link.icon;
          return (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                `flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-medium transition-all ${
                  isActive
                    ? "bg-indigo-600 text-white shadow-sm shadow-indigo-600/30"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
                }`
              }
            >
              <div className="flex items-center gap-3">
                <Icon className="h-4 w-4 shrink-0" />
                <span>{link.label}</span>
              </div>
              {link.badge && (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-rose-500 text-white rounded-full">
                  {link.badge}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="p-4 border-t border-slate-800/80">
        <div className="bg-slate-950/40 p-3 rounded-xl border border-slate-800/60 text-center">
          <p className="text-[11px] font-medium text-slate-300">Пилотные шаблоны</p>
          <div className="flex justify-center gap-2 mt-2">
            <span className="px-2 py-0.5 rounded-md bg-sky-500/10 text-sky-400 border border-sky-500/20 text-[10px]">
              Пилот A (Курсы)
            </span>
            <span className="px-2 py-0.5 rounded-md bg-purple-500/10 text-purple-400 border border-purple-500/20 text-[10px]">
              Пилот B (Барбер)
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
