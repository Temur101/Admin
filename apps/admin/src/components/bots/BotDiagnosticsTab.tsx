import { NotificationFailures } from "./NotificationFailures.js";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, CheckCircle2, Activity } from "lucide-react";
import type { BotDetails } from "../../api/bots.js";
import { getBotWebhookInfo, syncBotWebhook, getBotHealth } from "../../api/bots.js";
import { BotConnectionStatus } from "./BotConnectionStatus.js";
import { Button } from "../common/Button.js";
import { Alert } from "../common/Alert.js";

interface BotDiagnosticsTabProps {
  bot: BotDetails;
}

export function BotDiagnosticsTab({ bot }: BotDiagnosticsTabProps) {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<string | null>(null);

  const {
    data: webhookInfo,
    isLoading: isWbLoading,
    refetch: refetchWb,
  } = useQuery({
    queryKey: ["bot-webhook", bot.id],
    queryFn: () => getBotWebhookInfo(bot.id),
  });

  const {
    data: health,
    isLoading: isHealthLoading,
    refetch: refetchHealth,
  } = useQuery({
    queryKey: ["bot-health", bot.id],
    queryFn: () => getBotHealth(bot.id),
  });

  const syncMut = useMutation({
    mutationFn: () => syncBotWebhook(bot.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["bot-webhook", bot.id] });
      void queryClient.invalidateQueries({ queryKey: ["bot-health", bot.id] });
      setFeedback("Вебхук успешно синхронизирован.");
    },
    onError: (err: Error) => {
      setFeedback(`Ошибка синхронизации: ${err.message}`);
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ui-text">Диагностика связи и Webhook</h3>
          <p className="text-sm text-ui-muted mt-1">
            Проверка состояния Telegram Webhook, очереди необработанных апдейтов и ошибок
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => {
              void refetchWb();
              void refetchHealth();
            }}
          >
            Обновить статус
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => syncMut.mutate()}
            isLoading={syncMut.isPending}
          >
            Синхронизировать вебхук
          </Button>
        </div>
      </div>

      {feedback && (
        <Alert type="info" title="Результат">
          {feedback}
        </Alert>
      )}

      <BotConnectionStatus botId={bot.id} isActive={bot.isActive} />
      <NotificationFailures botId={bot.id} count={health?.failedNotificationCount ?? 0} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-5 bg-ui-surface border border-ui-border rounded-2xl space-y-3">
          <h4 className="text-sm font-semibold text-ui-secondary flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-ui-success" />
            <span>Состояние в Telegram API</span>
          </h4>

          {isWbLoading ? (
            <p className="text-sm text-ui-muted">Запрос в Telegram API...</p>
          ) : webhookInfo ? (
            <div className="space-y-2 text-sm">
              <div className="p-2.5 rounded-xl bg-ui-subtle border border-ui-border">
                <span className="text-ui-muted text-xs block">URL вебхука:</span>
                <span className="font-mono text-ui-secondary break-all">
                  {webhookInfo.url || "(Не установлен)"}
                </span>
              </div>
              <div className="flex justify-between p-2.5 rounded-xl bg-ui-subtle border border-ui-border">
                <span className="text-ui-muted">Очередь ожидающих апдейтов:</span>
                <span className="font-semibold text-ui-text font-mono">
                  {webhookInfo.pending_update_count}
                </span>
              </div>
              {webhookInfo.last_error_message && (
                <div className="p-2.5 rounded-xl bg-ui-danger-soft border border-ui-danger-border text-ui-danger">
                  <span className="text-xs text-ui-danger block font-semibold">
                    Последняя ошибка Telegram:
                  </span>
                  <p className="mt-0.5">{webhookInfo.last_error_message}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-ui-muted">Не удалось получить данные вебхука</p>
          )}
        </div>

        <div className="p-5 bg-ui-surface border border-ui-border rounded-2xl space-y-3">
          <h4 className="text-sm font-semibold text-ui-secondary flex items-center gap-2">
            <Activity className="h-4 w-4 text-ui-accent" />
            <span>Здоровье на платформе</span>
          </h4>

          {isHealthLoading ? (
            <p className="text-sm text-ui-muted">Проверка инбокса...</p>
          ) : health ? (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between p-2.5 rounded-xl bg-ui-subtle border border-ui-border">
                <span className="text-ui-muted">Флаг активности бота:</span>
                <span
                  className={`font-semibold ${health.isActive ? "text-ui-success" : "text-ui-danger"}`}
                >
                  {health.isActive ? "Активен" : "Приостановлен"}
                </span>
              </div>
              <div className="flex justify-between p-2.5 rounded-xl bg-ui-subtle border border-ui-border">
                <span className="text-ui-muted">Статус здоровья токена:</span>
                <span
                  className={`font-semibold ${
                    health.healthStatus === "NEEDS_ATTENTION"
                      ? "text-ui-danger"
                      : "text-ui-success"
                  }`}
                >
                  {health.healthStatus === "NEEDS_ATTENTION" ? "Требует внимания" : "В норме (OK)"}
                </span>
              </div>
              <div className="flex justify-between p-2.5 rounded-xl bg-ui-subtle border border-ui-border">
                <span className="text-ui-muted">Необработанные ошибки инбокса:</span>
                <span
                  className={`font-semibold font-mono ${
                    health.failedInboxCount > 0 ? "text-ui-danger" : "text-ui-success"
                  }`}
                >
                  {health.failedInboxCount}
                </span>
              </div>
              <div className="flex justify-between p-2.5 rounded-xl bg-ui-subtle border border-ui-border">
                <span className="text-ui-muted">Недоставленные уведомления:</span>
                <span className={health.failedNotificationCount ? "text-ui-danger" : "text-ui-success"}>{health.failedNotificationCount ?? 0}</span>
              </div>
              {health.lastErrorMsg && (
                <div className="p-2.5 rounded-xl bg-ui-danger-soft border border-ui-danger-border text-ui-danger">
                  <span className="text-xs text-ui-danger block font-semibold">
                    Последняя ошибка ({health.lastErrorCode ?? "UNKNOWN"}):
                  </span>
                  <p className="mt-0.5 break-all">{health.lastErrorMsg}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-ui-muted">Нет данных о здоровье</p>
          )}
        </div>
      </div>
    </div>
  );
}
