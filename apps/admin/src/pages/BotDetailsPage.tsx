import { BotLaunchWizard } from "../components/bots/onboarding/BotLaunchWizard.js";
import { useState } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Bot, Layout, Settings, Users, Activity, Sparkles, Inbox } from "lucide-react";
import { getBot } from "../api/bots.js";
import { StatusBadge } from "../components/common/Badge.js";
import { Alert } from "../components/common/Alert.js";
import { BotOverviewTab } from "../components/bots/BotOverviewTab.js";
import { BotTemplatesTab } from "../components/bots/BotTemplatesTab.js";
import { BotQuizEditorTab } from "../components/bots/BotQuizEditorTab.js";
import { BotScheduleEditorTab } from "../components/bots/BotScheduleEditorTab.js";
import { BotAdminsTab } from "../components/bots/BotAdminsTab.js";
import { BotDiagnosticsTab } from "../components/bots/BotDiagnosticsTab.js";
import { BotLeadsTab } from "../components/bots/BotLeadsTab.js";
import { BotResetSection } from "../components/bots/BotResetSection.js";

type TabId = "overview" | "leads" | "templates" | "config" | "admins" | "diagnostics";

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
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ui-accent" />
      </div>
    );
  }

  if (error || !bot) {
    return (
      <div className="space-y-4">
        <Link
          to="/bots"
          className="inline-flex items-center gap-2 text-sm text-ui-muted hover:text-ui-text transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Назад к списку ботов
        </Link>
        <Alert type="error" title="Ошибка загрузки бота">
          {error instanceof Error ? error.message : "Бот не найден"}
        </Alert>
      </div>
    );
  }

  if (search.get("setup") === "1") return <BotLaunchWizard key={bot.id} bot={bot} />;

  const tabs: Array<{ id: TabId; label: string; icon: typeof Layout }> = [
    { id: "overview", label: "Обзор", icon: Layout },
    ...(bot.botType === "LEADCATCH"
      ? [{ id: "leads" as const, label: "Заявки", icon: Inbox }]
      : []),
    { id: "templates", label: "Шаблоны", icon: Sparkles },
    { id: "config", label: "Настройка бота", icon: Settings },
    { id: "admins", label: "Администраторы", icon: Users },
    { id: "diagnostics", label: "Диагностика", icon: Activity },
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
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

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-ui-accent-soft rounded-2xl border border-ui-accent-border">
              <Bot className="h-6 w-6 text-ui-accent" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold text-ui-text">
                  {bot.botUsername ? `@${bot.botUsername}` : "Бот без юзернейма"}
                </h1>
                <StatusBadge status={bot.subscription?.status || "UNKNOWN"} />
              </div>
              <p className="text-sm text-ui-muted mt-0.5">
                Клиент:{" "}
                <Link
                  to={`/tenants/${bot.tenantId}`}
                  className="font-medium text-ui-text hover:underline"
                >
                  {bot.tenantName}
                </Link>{" "}
                · Тип:{" "}
                <span className="font-medium text-ui-text">
                  {bot.botType === "LEADCATCH" ? "Сбор заявок" : "Запись на услуги"}
                </span>
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex border-b border-ui-border overflow-x-auto gap-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors cursor-pointer ${
                isActive
                  ? "border-ui-accent text-ui-accent"
                  : "border-transparent text-ui-muted hover:text-ui-text hover:border-ui-border"
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <div className="pt-2">
        {activeTab === "overview" && <BotOverviewTab bot={bot} />}
        {activeTab === "leads" && <BotLeadsTab bot={bot} />}
        {activeTab === "templates" && (
          <BotTemplatesTab bot={bot} onApplied={() => setEditorRevision((value) => value + 1)} />
        )}
        <div hidden={activeTab !== "config"}>
          {bot.botType === "LEADCATCH" ? (
            <BotQuizEditorTab key={`${bot.id}:${editorRevision}`} bot={bot} />
          ) : (
            <BotScheduleEditorTab key={`${bot.id}:${editorRevision}`} bot={bot} />
          )}
          <BotResetSection bot={bot} />
        </div>
        {activeTab === "admins" && <BotAdminsTab bot={bot} />}
        {activeTab === "diagnostics" && <BotDiagnosticsTab bot={bot} />}
      </div>
    </div>
  );
}
