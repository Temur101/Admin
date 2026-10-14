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

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["bot", bot.id] });

  const suspendMut = useMutation({
    mutationFn: () => suspendBot(bot.id),
    onSuccess: () => {
      invalidate();
      setFeedback("Бот успешно приостановлен. Вебхук снят в Telegram.");
    },
  });

  const resumeMut = useMutation({
    mutationFn: () => resumeBot(bot.id),
    onSuccess: () => {
      invalidate();
      setFeedback("Бот возобновлен. Вебхук снова активен.");
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
    if (confirm("ВНИМАНИЕ! Полное удаление уничтожит всех лидов, брони и чеки этого бота без возможности восстановления. Продолжить?")) {
      deleteBot(bot.id, true).then(() => {
        window.location.href = "/bots";
      });
    }
  };

  return (
    <div className="space-y-6">
      {feedback && (
        <Alert type="success" title="Успешно">
          {feedback}
        </Alert>
      )}

      {/* Статус активности бота и переход в Telegram */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-slate-900 border border-slate-800 rounded-2xl">
        <div className="flex items-center gap-3">
          {bot.isActive ? (
            <div className="flex items-center gap-2">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
              <span className="text-xs font-semibold text-emerald-400">Бот онлайн</span>
              <span className="text-[11px] text-slate-500 hidden sm:inline">· отвечает на сообщения</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full bg-rose-500"></span>
              <span className="text-xs font-semibold text-rose-400">Бот приостановлен</span>
              <span className="text-[11px] text-slate-500 hidden sm:inline">· polling / вебхук выключен</span>
            </div>
          )}
        </div>
        {bot.botUsername && (
          <a
            href={`https://t.me/${bot.botUsername}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-sky-500/10 text-sky-400 border border-sky-500/20 hover:bg-sky-500/20 text-xs font-medium transition-colors cursor-pointer w-fit"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Открыть @{bot.botUsername} в Telegram
          </a>
        )}
      </div>

      {/* Основные карточки */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl space-y-2">
          <p className="text-xs font-medium text-slate-400">Статус подписки</p>
          <div className="flex items-center gap-2">
            <StatusBadge status={bot.subscription?.status || (bot.isActive ? "ACTIVE" : "SUSPENDED")} />
            {!bot.isActive && <span className="text-xs text-rose-400">(Деактивирован)</span>}
          </div>
          {bot.subscription?.paidUntil ? (
            <p className="text-xs text-slate-400">
              Оплачен до:{" "}
              <span className="font-semibold text-white">
                {new Date(bot.subscription.paidUntil).toLocaleDateString("ru-RU")}
              </span>
            </p>
          ) : bot.subscription?.trialEndsAt ? (
            <p className="text-xs text-slate-400">
              Триал до:{" "}
              <span className="font-semibold text-white">
                {new Date(bot.subscription.trialEndsAt).toLocaleDateString("ru-RU")}
              </span>
            </p>
          ) : null}
        </div>

        <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl space-y-2">
          <p className="text-xs font-medium text-slate-400">Операционные метрики</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">
              {bot.botType === "LEADCATCH" ? bot.stats.leadsCount : bot.stats.bookingsCount}
            </span>
            <span className="text-xs text-slate-500">
              {bot.botType === "LEADCATCH" ? "заявок" : "записей"}
            </span>
          </div>
          <p className="text-xs text-slate-400 flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-indigo-400" />
            <span>{bot.stats.usersCount} администраторов в боте</span>
          </p>
        </div>

        <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl space-y-2">
          <p className="text-xs font-medium text-slate-400">Быстрые действия</p>
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
        <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Ссылка-приглашение для администратора</h3>
            <span className="text-[11px] text-slate-400">Передайте эту ссылку клиенту для входа</span>
          </div>
          <div className="flex gap-2">
            <input
              readOnly
              value={bot.inviteLink}
              className="flex-1 px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-slate-300"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleCopy(bot.inviteLink!)}
              icon={copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            >
              {copied ? "Скопировано" : "Копировать"}
            </Button>
          </div>
        </div>
      )}

      {/* Опасная зона */}
      <div className="p-5 bg-rose-500/5 border border-rose-500/20 rounded-2xl flex items-center justify-between">
        <div>
          <h4 className="text-xs font-semibold text-rose-300">Окончательное удаление данных</h4>
          <p className="text-[11px] text-slate-400 mt-0.5">
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
