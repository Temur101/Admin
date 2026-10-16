import { useEffect } from "react";
import { NavLink } from "react-router-dom";
import { LayoutDashboard, Users, Bot, Receipt, Settings, Sparkles, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getReceipts } from "../../api/receipts.js";

export function Sidebar({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);
  const { data: pendingReceipts } = useQuery({
    queryKey: ["pending-receipts-count"],
    queryFn: () => getReceipts("PENDING"),
    refetchInterval: 15000,
  });

  const pendingCount = pendingReceipts?.length ?? 0;

  const links = [
    {
      to: "/dashboard",
      label: "Обзор",
      icon: LayoutDashboard,
    },
    {
      to: "/tenants",
      label: "Клиенты",
      icon: Users,
    },
    {
      to: "/bots",
      label: "Боты",
      icon: Bot,
    },
    {
      to: "/receipts",
      label: "Оплаты",
      icon: Receipt,
      badge: pendingCount > 0 ? pendingCount : null,
    },
    {
      to: "/settings",
      label: "Настройки платформы",
      icon: Settings,
    },
  ];

  return (
    <>
      {isOpen && (
        <button
          aria-label="Закрыть навигацию"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-ui-overlay lg:hidden"
        />
      )}
      <aside
        aria-label="Основная навигация"
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-ui-surface border-r border-ui-border flex flex-col shrink-0 min-h-screen transition-transform lg:static lg:translate-x-0 ${isOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="h-16 flex items-center gap-3 px-6 border-b border-ui-border">
          <div className="h-9 w-9 rounded-xl bg-ui-accent flex items-center justify-center text-ui-on-accent shadow-sm">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <p className="font-bold text-sm tracking-tight text-ui-text">LCQB Platform</p>
            <p className="text-xs font-medium text-ui-muted">Telegram-боты</p>
          </div>
        </div>

        <button
          aria-label="Закрыть меню"
          onClick={onClose}
          className="absolute right-2 top-4 p-2 text-ui-muted lg:hidden"
        >
          <X className="h-4 w-4" />
        </button>
        <nav className="flex-1 p-3 space-y-1">
          {links.map((link) => {
            const Icon = link.icon;
            return (
              <NavLink
                key={link.to}
                to={link.to}
                onClick={onClose}
                className={({ isActive }) =>
                  `flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all border ${
                    isActive
                      ? "bg-ui-accent-soft text-ui-accent border-ui-accent-border"
                      : "border-transparent text-ui-secondary hover:text-ui-text hover:bg-ui-hover"
                  }`
                }
              >
                <div className="flex items-center gap-3">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{link.label}</span>
                </div>
                {link.badge && (
                  <span className="px-1.5 py-0.5 text-xs font-semibold bg-ui-danger text-ui-on-accent rounded-full">
                    {link.badge}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
