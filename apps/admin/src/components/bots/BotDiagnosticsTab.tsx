import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, CheckCircle2, Activity } from "lucide-react";
import type { BotDetails } from "../../api/bots.js";
import { getBotWebhookInfo, syncBotWebhook, getBotHealth } from "../../api/bots.js";
import { Button } from "../common/Button.js";
import { Alert } from "../common/Alert.js";

interface BotDiagnosticsTabProps {
  bot: BotDetails;
}

export function BotDiagnosticsTab({ bot }: BotDiagnosticsTabProps) {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<string | null>(null);

  const { data: webhookInfo, isLoading: isWbLoading, refetch: refetchWb } = useQuery({
    queryKey: ["bot-webhook", bot.id],
    queryFn: () => getBotWebhookInfo(bot.id),
  });

  const { data: health, isLoading: isHealthLoading, refetch: refetchHealth } = useQuery({
    queryKey: ["bot-health", bot.id],
    queryFn: () => getBotHealth(bot.id),
  });

  const syncMut = useMutation({
    mutationFn: () => syncBotWebhook(bot.id),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["bot-webhook", bot.id] });
      setFeedback(`Вебхук успешно синхронизирован с новым секретом (${data.webhookSecret.slice(0, 8)}...).`);
    },
    onError: (err: Error) => {
      setFeedback(`Ошибка синхронизации: ${err.message}`);
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Диагностика связи и Webhook</h3>
          <p className="text-xs text-slate-400 mt-1">
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

      {/* Диагностические панели */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Telegram Webhook Info */}
        <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl space-y-3">
          <h4 className="text-xs font-semibold text-slate-300 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            <span>Состояние в Telegram API</span>
          </h4>

          {isWbLoading ? (
            <p className="text-xs text-slate-500">Запрос в Telegram API...</p>
          ) : webhookInfo ? (
            <div className="space-y-2 text-xs">
              <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-500 text-[10px] block">URL вебхука:</span>
                <span className="font-mono text-slate-300 break-all">{webhookInfo.url || "(Не установлен)"}</span>
              </div>
              <div className="flex justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-400">Очередь ожидающих апдейтов:</span>
                <span className="font-semibold text-white font-mono">{webhookInfo.pending_update_count}</span>
              </div>
              {webhookInfo.last_error_message && (
                <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300">
                  <span className="text-[10px] text-rose-400 block font-semibold">Последняя ошибка Telegram:</span>
                  <p className="mt-0.5">{webhookInfo.last_error_message}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-500">Не удалось получить данные вебхука</p>
          )}
        </div>

        {/* Платформенный Health Probe */}
        <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl space-y-3">
          <h4 className="text-xs font-semibold text-slate-300 flex items-center gap-2">
            <Activity className="h-4 w-4 text-indigo-400" />
            <span>Здоровье на платформе</span>
          </h4>

          {isHealthLoading ? (
            <p className="text-xs text-slate-500">Проверка инбокса...</p>
          ) : health ? (
            <div className="space-y-2 text-xs">
              <div className="flex justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-400">Флаг активности бота:</span>
                <span className={`font-semibold ${health.isActive ? "text-emerald-400" : "text-rose-400"}`}>
                  {health.isActive ? "Активен" : "Приостановлен"}
                </span>
              </div>
              <div className="flex justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
                <span className="text-slate-400">Необработанные ошибки инбокса:</span>
                <span
                  className={`font-semibold font-mono ${
                    health.failedInboxCount > 0 ? "text-rose-400" : "text-emerald-400"
                  }`}
                >
                  {health.failedInboxCount}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">Нет данных о здоровье</p>
          )}
        </div>
      </div>
    </div>
  );
}
