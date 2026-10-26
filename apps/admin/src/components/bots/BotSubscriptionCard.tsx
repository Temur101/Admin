import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, Sparkles } from "lucide-react";
import type { BotDetails } from "../../api/bots.js";
import {
  extendBotSubscription,
  reduceBotSubscription,
  grantBotTrial,
} from "../../api/bots.js";
import { formatPlatformDate } from "../../utils/dates.js";
import { StatusBadge } from "../common/Badge.js";
import { Button } from "../common/Button.js";
import { ApiErrorAlert } from "../common/ApiErrorAlert.js";
import { Alert } from "../common/Alert.js";

interface BotSubscriptionCardProps {
  bot: BotDetails;
}

export function BotSubscriptionCard({ bot }: BotSubscriptionCardProps) {
  const queryClient = useQueryClient();
  const [customDays, setCustomDays] = useState("30");
  const [trialDays, setTrialDays] = useState("7");
  const [feedback, setFeedback] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["bot", bot.id] });
    void queryClient.invalidateQueries({ queryKey: ["bot-health", bot.id] });
    void queryClient.invalidateQueries({ queryKey: ["bots"] });
  };

  const extendMut = useMutation({
    mutationFn: (days: number) => extendBotSubscription(bot.id, { days }),
    onSuccess: () => {
      invalidate();
      setFeedback("Подписка успешно продлена.");
    },
  });

  const reduceMut = useMutation({
    mutationFn: (days: number) => reduceBotSubscription(bot.id, { days }),
    onSuccess: () => {
      invalidate();
      setFeedback("Срок подписки уменьшен.");
    },
  });

  const trialMut = useMutation({
    mutationFn: (days: number) => grantBotTrial(bot.id, { days }),
    onSuccess: () => {
      invalidate();
      setFeedback("Пробный период успешно установлен.");
    },
  });

  const parsedCustomDays = parseInt(customDays, 10);
  const isValidCustomDays =
    !isNaN(parsedCustomDays) && parsedCustomDays >= 1 && parsedCustomDays <= 3650;

  const parsedTrialDays = parseInt(trialDays, 10);
  const isValidTrialDays =
    !isNaN(parsedTrialDays) && parsedTrialDays >= 1 && parsedTrialDays <= 365;

  const isPaidActive =
    bot.subscription?.status === "ACTIVE" &&
    bot.subscription?.paidUntil != null &&
    new Date(bot.subscription.paidUntil).getTime() > Date.now();

  const handleReduce = () => {
    if (!isValidCustomDays) return;
    if (confirm(`Вы уверены, что хотите сократить подписку на ${parsedCustomDays} дн.?`)) {
      reduceMut.mutate(parsedCustomDays);
    }
  };

  const handleGrantTrial = () => {
    if (!isValidTrialDays) return;
    if (bot.subscription?.status === "TRIAL") {
      if (!confirm(`Заменить текущий пробный период на новый (${parsedTrialDays} дн.)?`)) {
        return;
      }
    }
    trialMut.mutate(parsedTrialDays);
  };

  const anyLoading = extendMut.isPending || reduceMut.isPending || trialMut.isPending;
  const anyError = extendMut.error || reduceMut.error || trialMut.error;

  return (
    <div className="p-5 bg-ui-surface border border-ui-border rounded-2xl space-y-4">
      <div>
        <p className="text-sm font-medium text-ui-muted">Статус подписки</p>
        <div className="flex items-center gap-2 mt-1">
          <StatusBadge status={bot.subscription?.status || "UNKNOWN"} />
          {!bot.isActive && <span className="text-sm text-ui-danger">(Деактивирован)</span>}
        </div>
        {bot.subscription?.paidUntil ? (
          <p className="text-sm text-ui-muted mt-1.5">
            Оплачен до (Ташкент):{" "}
            <span className="font-semibold text-ui-text">
              {formatPlatformDate(bot.subscription.paidUntil)}
            </span>
          </p>
        ) : bot.subscription?.trialEndsAt ? (
          <p className="text-sm text-ui-muted mt-1.5">
            Пробный период до (Ташкент):{" "}
            <span className="font-semibold text-ui-text">
              {formatPlatformDate(bot.subscription.trialEndsAt)}
            </span>
          </p>
        ) : null}
      </div>

      <ApiErrorAlert error={anyError} />
      {feedback && (
        <Alert type="success" title="Успешно">
          {feedback}
        </Alert>
      )}

      {/* Быстрое и произвольное продление / сокращение */}
      <div className="border-t border-ui-border pt-3 space-y-2.5">
        <p className="text-xs font-semibold text-ui-secondary uppercase tracking-wider">
          Продление и сокращение
        </p>

        {/* Быстрые кнопки */}
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="sm"
            icon={<Clock className="h-3.5 w-3.5" />}
            onClick={() => extendMut.mutate(30)}
            isLoading={extendMut.isPending}
            disabled={anyLoading}
          >
            +30 дней
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon={<Clock className="h-3.5 w-3.5" />}
            onClick={() => extendMut.mutate(180)}
            isLoading={extendMut.isPending}
            disabled={anyLoading}
          >
            +180 дней
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon={<Clock className="h-3.5 w-3.5" />}
            onClick={() => extendMut.mutate(365)}
            isLoading={extendMut.isPending}
            disabled={anyLoading}
          >
            +365 дней
          </Button>
        </div>

        {/* Произвольное число дней */}
        <div className="flex items-center gap-2 pt-1">
          <input
            type="number"
            min={1}
            max={3650}
            value={customDays}
            onChange={(e) => setCustomDays(e.target.value)}
            disabled={anyLoading}
            placeholder="Дней"
            className="w-24 min-h-9 px-2.5 py-1.5 bg-ui-subtle border border-ui-border rounded-lg text-sm text-ui-text focus:outline-hidden focus:ring-2 focus:ring-ui-accent"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => extendMut.mutate(parsedCustomDays)}
            disabled={!isValidCustomDays || anyLoading}
            isLoading={extendMut.isPending}
          >
            Продлить
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReduce}
            disabled={!isValidCustomDays || anyLoading}
            isLoading={reduceMut.isPending}
          >
            Уменьшить
          </Button>
        </div>
      </div>

      {/* Выдача пробного периода */}
      <div className="border-t border-ui-border pt-3 space-y-2">
        <p className="text-xs font-semibold text-ui-secondary uppercase tracking-wider">
          Пробный период
        </p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={365}
            value={trialDays}
            onChange={(e) => setTrialDays(e.target.value)}
            disabled={isPaidActive || anyLoading}
            placeholder="7"
            className="w-20 min-h-9 px-2.5 py-1.5 bg-ui-subtle border border-ui-border rounded-lg text-sm text-ui-text focus:outline-hidden focus:ring-2 focus:ring-ui-accent disabled:opacity-50"
          />
          <Button
            variant="secondary"
            size="sm"
            icon={<Sparkles className="h-3.5 w-3.5 text-ui-accent" />}
            onClick={handleGrantTrial}
            disabled={isPaidActive || !isValidTrialDays || anyLoading}
            isLoading={trialMut.isPending}
          >
            Выдать пробный
          </Button>
        </div>
        {isPaidActive && (
          <p className="text-xs text-ui-muted">
            Недоступно: у бота действует оплаченная подписка.
          </p>
        )}
      </div>
    </div>
  );
}
