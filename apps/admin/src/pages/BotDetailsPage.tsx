import { BotLaunchWizard } from "../components/bots/onboarding/BotLaunchWizard.js";
import { useState } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
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
  const [search] = useSearchParams();
  const [editorRevision, setEditorRevision] = useState(0);
  const [activeTab, setActiveTab] = useState<TabId>("overview");

  const {
    data: bot,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["bot", id],
    queryFn: () => getBot(id!),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-6 w-32 bg-ui-hover rounded" />
        <div className="h-20 bg-ui-surface border border-ui-border rounded-2xl" />
        <div className="h-64 bg-ui-surface border border-ui-border rounded-2xl" />
      </div>
    );
  }

  if (error || !bot) {
    return (
      <div className="space-y-4">
        <Link
          to="/bots"
          className="inline-flex items-center gap-1.5 text-sm text-ui-accent hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Назад к списку ботов
        </Link>
        <Alert type="error" title="Бот не найден">
          Не удалось найти бота с указанным ID. Возможно, он был удален.
        </Alert>
      </div>
    );
  }

  if (search.get("setup") === "1") return <BotLaunchWizard key={bot.id} bot={bot} />;

  const tabs: Array<{ id: TabId; label: string; icon: typeof Layout }> = [
    { id: "overview", label: "Обзор", icon: Layout },
    { id: "templates", label: "Шаблоны", icon: Sparkles },
    { id: "config", label: "Настройка бота", icon: Settings },
    { id: "admins", label: "Администраторы", icon: Users },
    { id: "diagnostics", label: "Диагностика", icon: Activity },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <Link
          to="/bots"
          className="inline-flex items-center gap-1.5 text-sm text-ui-accent hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Все боты
        </Link>

        <Link to={`/bots/${bot.id}?setup=1`} className="inline-flex text-sm text-ui-accent">
          Открыть мастер запуска
        </Link>
      </div>
      {/* Заголовок бота */}
      <div className="p-6 bg-ui-surface border border-ui-border rounded-2xl flex flex-col sm:flex-row sm:flex-wrap sm:items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="h-12 w-12 shrink-0 rounded-2xl bg-ui-accent-soft text-ui-accent flex items-center justify-center">
            <Bot className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="w-full text-xl font-bold text-ui-text tracking-tight break-all">
                {bot.botUsername ? `@${bot.botUsername}` : "Telegram Bot"}
              </h1>
              <span className="font-mono text-sm px-2 py-0.5 rounded-md bg-ui-hover text-ui-secondary border border-ui-border">
                {bot.botType}
              </span>
            </div>
            <p className="text-sm text-ui-muted mt-0.5">
              Клиент: <span className="text-ui-text font-medium">{bot.tenantName}</span> · ID:{" "}
              <span className="font-mono">{bot.id}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <StatusBadge status={bot.subscription?.status || "UNKNOWN"} />
        </div>
      </div>

      {/* Навигационные табы */}
      <div className="border-b border-ui-border flex gap-2 overflow-x-auto pb-px">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-xl transition-all cursor-pointer border-b-2 -mb-px shrink-0 ${
                isActive
                  ? "border-ui-accent text-ui-text bg-ui-surface"
                  : "border-transparent text-ui-muted hover:text-ui-text hover:bg-ui-surface"
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
        {activeTab === "templates" && (
          <BotTemplatesTab bot={bot} onApplied={() => setEditorRevision((value) => value + 1)} />
        )}
        <div hidden={activeTab !== "config"}>
          {bot.botType === "LEADCATCH" ? (
            <BotQuizEditorTab key={`${bot.id}:${editorRevision}`} bot={bot} />
          ) : (
            <BotScheduleEditorTab key={`${bot.id}:${editorRevision}`} bot={bot} />
          )}
        </div>
        {activeTab === "admins" && <BotAdminsTab bot={bot} />}
        {activeTab === "diagnostics" && <BotDiagnosticsTab bot={bot} />}
      </div>
    </div>
  );
}
