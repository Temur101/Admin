import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Bot, Layout, Settings, Users, Activity, Sparkles } from "lucide-react";
import { getBot } from "../api/bots.js";
import { StatusBadge } from "../components/common/Badge.js";
import { Alert } from "../components/common/Alert.js";
import { BotOverviewTab } from "../components/bots/BotOverviewTab.js";
import { BotTemplatesTab } from "../components/bots/BotTemplatesTab.js";
import { BotQuizEditorTab } from "../components/bots/BotQuizEditorTab.js";
import { BotScheduleEditorTab } from "../components/bots/BotScheduleEditorTab.js";
import { BotAdminsTab } from "../components/bots/BotAdminsTab.js";
import { BotDiagnosticsTab } from "../components/bots/BotDiagnosticsTab.js";

type TabId = "overview" | "templates" | "config" | "admins" | "diagnostics";

export function BotDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const [activeTab, setActiveTab] = useState<TabId>("overview");

  const { data: bot, isLoading, error } = useQuery({
    queryKey: ["bot", id],
    queryFn: () => getBot(id!),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-6 w-32 bg-slate-800 rounded" />
        <div className="h-20 bg-slate-900 border border-slate-800 rounded-2xl" />
        <div className="h-64 bg-slate-900 border border-slate-800 rounded-2xl" />
      </div>
    );
  }

  if (error || !bot) {
    return (
      <div className="space-y-4">
        <Link to="/bots" className="inline-flex items-center gap-1.5 text-xs text-indigo-400 hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" /> Назад к списку ботов
        </Link>
        <Alert type="error" title="Бот не найден">
          Не удалось найти бота с указанным ID. Возможно, он был удален.
        </Alert>
      </div>
    );
  }

  const tabs: Array<{ id: TabId; label: string; icon: typeof Layout }> = [
    { id: "overview", label: "Обзор", icon: Layout },
    { id: "templates", label: "Шаблоны", icon: Sparkles },
    { id: "config", label: "Конфигурация", icon: Settings },
    { id: "admins", label: "Администраторы", icon: Users },
    { id: "diagnostics", label: "Диагностика", icon: Activity },
  ];

  return (
    <div className="space-y-6">
      <Link to="/bots" className="inline-flex items-center gap-1.5 text-xs text-indigo-400 hover:underline">
        <ArrowLeft className="h-3.5 w-3.5" /> Все боты
      </Link>

      {/* Заголовок бота */}
      <div className="p-6 bg-slate-900 border border-slate-800 rounded-2xl flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-2xl bg-indigo-600/10 text-indigo-400 flex items-center justify-center">
            <Bot className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold text-white tracking-tight">
                {bot.botUsername ? `@${bot.botUsername}` : "Telegram Bot"}
              </h1>
              <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700">
                {bot.botType}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Клиент: <span className="text-slate-200 font-medium">{bot.tenantName}</span> · ID:{" "}
              <span className="font-mono">{bot.id}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <StatusBadge status={bot.subscription?.status || (bot.isActive ? "ACTIVE" : "SUSPENDED")} />
        </div>
      </div>

      {/* Навигационные табы */}
      <div className="border-b border-slate-800 flex gap-2 overflow-x-auto pb-px">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium rounded-t-xl transition-all cursor-pointer border-b-2 -mb-px shrink-0 ${
                isActive
                  ? "border-indigo-500 text-white bg-slate-900/60"
                  : "border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/30"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Содержимое активного таба */}
      <div className="pt-2">
        {activeTab === "overview" && <BotOverviewTab bot={bot} />}
        {activeTab === "templates" && <BotTemplatesTab bot={bot} />}
        {activeTab === "config" &&
          (bot.botType === "LEADCATCH" ? (
            <BotQuizEditorTab bot={bot} />
          ) : (
            <BotScheduleEditorTab bot={bot} />
          ))}
        {activeTab === "admins" && <BotAdminsTab bot={bot} />}
        {activeTab === "diagnostics" && <BotDiagnosticsTab bot={bot} />}
      </div>
    </div>
  );
}
