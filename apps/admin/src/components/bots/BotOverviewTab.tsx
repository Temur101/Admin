import { BotConnectionStatus } from "./BotConnectionStatus.js";
import { ApiErrorAlert } from "../common/ApiErrorAlert.js";
import { formatPlatformDate } from "../../utils/dates.js";
import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  PauseCircle,
  PlayCircle,
  Trash2,
  Clock,
  ShieldCheck,
  Check,
  Copy,
  Users,
  ExternalLink,
} from "lucide-react";
import type { BotDetails } from "../../api/bots.js";
import {
  suspendBot,
  resumeBot,
  deleteBot,
  extendBotSubscription,
  unblockBot,
} from "../../api/bots.js";
import { Button } from "../common/Button.js";
import { StatusBadge } from "../common/Badge.js";
import { Alert } from "../common/Alert.js";

interface BotOverviewTabProps {
  bot: BotDetails;
}

export function BotOverviewTab({ bot }: BotOverviewTabProps) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["bot", bot.id] });
    void queryClient.invalidateQueries({ queryKey: ["bot-health", bot.id] });
    void queryClient.invalidateQueries({ queryKey: ["bots"] });
  };

  const suspendMut = useMutation({
    mutationFn: () => suspendBot(bot.id),
    onSuccess: () => {
      invalidate();
      setFeedback("Бот приостановлен.");
    },
  });

  const resumeMut = useMutation({
    mutationFn: () => resumeBot(bot.id),
    onSuccess: () => {
      invalidate();
      setFeedback("Бот включён. Проверьте состояние подключения.");
    },
  });

  const extendMut = useMutation({
    mutationFn: (days: number) => extendBotSubscription(bot.id, { days }),
    onSuccess: () => {
      invalidate();
      setFeedback("Подписка успешно продлена.");
    },
  });

  const unblockMut = useMutation({
    mutationFn: () => unblockBot(bot.id),
    onSuccess: () => {
      invalidate();
      setFeedback("Бот успешно разблокирован.");
    },
  });

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePurge = () => {
    if (
      confirm(
        "ВНИМАНИЕ! Полное удаление уничтожит всех лидов, брони и чеки этого бота без возможности восстановления. Продолжить?",
      )
    ) {
      deleteBot(bot.id, true).then(() => {
        window.location.href = "/bots";
      });
    }
  };

  return (
    <div className="space-y-6">
      <ApiErrorAlert
        error={suspendMut.error || resumeMut.error || extendMut.error || unblockMut.error}
      />
      {feedback && (
        <Alert type="success" title="Успешно">
          {feedback}
        </Alert>
      )}

      {/* Статус активности бота и переход в Telegram */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-ui-surface border border-ui-border rounded-2xl">
        <div className="flex items-center gap-3">
          <BotConnectionStatus botId={bot.id} isActive={bot.isActive} />
        </div>
        {bot.botUsername && (
          <a
            href={`https://t.me/${bot.botUsername}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-ui-info-soft text-ui-info border border-ui-info-border hover:bg-ui-info-soft text-sm font-medium transition-colors cursor-pointer w-fit"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Открыть @{bot.botUsername} в Telegram
          </a>
        )}
      </div>

      {/* Основные карточки */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-5 bg-ui-surface border border-ui-border rounded-2xl space-y-2">
          <p className="text-sm font-medium text-ui-muted">Статус подписки</p>
          <div className="flex items-center gap-2">
            <StatusBadge status={bot.subscription?.status || "UNKNOWN"} />
            {!bot.isActive && <span className="text-sm text-ui-danger">(Деактивирован)</span>}
          </div>
          {bot.subscription?.paidUntil ? (
            <p className="text-sm text-ui-muted">
              Оплачен до (Ташкент):{" "}
              <span className="font-semibold text-ui-text">
                {formatPlatformDate(bot.subscription.paidUntil)}
              </span>
            </p>
          ) : bot.subscription?.trialEndsAt ? (
            <p className="text-sm text-ui-muted">
              Пробный период до (Ташкент):{" "}
              <span className="font-semibold text-ui-text">
                {formatPlatformDate(bot.subscription.trialEndsAt)}
              </span>
            </p>
          ) : null}
        </div>

        <div className="p-5 bg-ui-surface border border-ui-border rounded-2xl space-y-2">
          <p className="text-sm font-medium text-ui-muted">Операционные метрики</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-ui-text">
              {bot.botType === "LEADCATCH" ? bot.stats.leadsCount : bot.stats.bookingsCount}
            </span>
            <span className="text-sm text-ui-muted">
              {bot.botType === "LEADCATCH" ? "заявок" : "записей"}
            </span>
          </div>
          <p className="text-sm text-ui-muted flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-ui-accent" />
            <span>{bot.stats.usersCount} администраторов в боте</span>
          </p>
        </div>

        <div className="p-5 bg-ui-surface border border-ui-border rounded-2xl space-y-2">
          <p className="text-sm font-medium text-ui-muted">Быстрые действия</p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              icon={<Clock className="h-3.5 w-3.5" />}
              onClick={() => extendMut.mutate(30)}
              isLoading={extendMut.isPending}
            >
              +30 дней
            </Button>
            {bot.subscription?.status === "BLOCKED" && (
              <Button
                variant="primary"
                size="sm"
                icon={<ShieldCheck className="h-3.5 w-3.5" />}
                onClick={() => unblockMut.mutate()}
                isLoading={unblockMut.isPending}
              >
                Разблокировать
              </Button>
            )}
            {bot.isActive ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<PauseCircle className="h-3.5 w-3.5" />}
                onClick={() => suspendMut.mutate()}
                isLoading={suspendMut.isPending}
              >
                Приостановить
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon={<PlayCircle className="h-3.5 w-3.5" />}
                onClick={() => resumeMut.mutate()}
                isLoading={resumeMut.isPending}
              >
                Возобновить
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Инвайт ссылка */}
      {bot.inviteLink && (
        <div className="p-5 bg-ui-surface border border-ui-border rounded-2xl space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-ui-text">
              Ссылка-приглашение для администратора
            </h3>
            <span className="text-sm text-ui-muted">Передайте эту ссылку клиенту для входа</span>
          </div>
          <div className="flex gap-2">
            <input
              readOnly
              value={bot.inviteLink}
              className="flex-1 px-3 py-2 bg-ui-subtle border border-ui-border rounded-xl text-sm font-mono text-ui-secondary"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleCopy(bot.inviteLink!)}
              icon={
                copied ? (
                  <Check className="h-3.5 w-3.5 text-ui-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )
              }
            >
              {copied ? "Скопировано" : "Копировать"}
            </Button>
          </div>
        </div>
      )}

      {/* Опасная зона */}
      <div className="p-5 bg-ui-danger-soft border border-ui-danger-border rounded-2xl flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-ui-danger">Окончательное удаление данных</h4>
          <p className="text-sm text-ui-muted mt-0.5">
            Безвозвратно удаляет бота и все его связанные заявки, брони и чеки.
          </p>
        </div>
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={handlePurge}
        >
          Удалить навсегда
        </Button>
      </div>
    </div>
  );
}
