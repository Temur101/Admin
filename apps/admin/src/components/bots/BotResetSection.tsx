import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, AlertTriangle, X } from "lucide-react";
import type { BotDetails } from "../../api/bots.js";
import { resetBot } from "../../api/bots.js";
import { Button } from "../common/Button.js";
import { ApiErrorAlert } from "../common/ApiErrorAlert.js";

interface BotResetSectionProps {
  bot: BotDetails;
}

export function BotResetSection({ bot }: BotResetSectionProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");

  const targetPhrase = bot.botUsername ? `@${bot.botUsername}` : bot.id;

  const resetMut = useMutation({
    mutationFn: () => resetBot(bot.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["bot", bot.id] });
      void queryClient.invalidateQueries({ queryKey: ["bot-health", bot.id] });
      void queryClient.invalidateQueries({ queryKey: ["bots"] });
      setIsOpen(false);
      setConfirmInput("");
      navigate(`/bots/${bot.id}?setup=1`);
    },
  });

  const handleOpen = () => {
    setConfirmInput("");
    setIsOpen(true);
  };

  const handleClose = () => {
    if (resetMut.isPending) return;
    setIsOpen(false);
    setConfirmInput("");
  };

  const isConfirmed = confirmInput.trim() === targetPhrase;

  return (
    <div className="mt-8 p-5 bg-ui-danger-soft border border-ui-danger-border rounded-2xl space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h4 className="text-sm font-semibold text-ui-danger flex items-center gap-2">
            <RotateCcw className="h-4 w-4" />
            Сброс настроек бота
          </h4>
          <p className="text-sm text-ui-muted max-w-2xl">
            Сбросит сценарий, услуги, расписание и тексты до начального пустого состояния,
            прервёт незавершённые диалоги в Telegram и переведёт бота на паузу для повторной
            настройки в мастере. Токен бота, подписка, администраторы, заявки и записи сохранятся.
          </p>
        </div>
        <Button
          variant="danger"
          size="sm"
          icon={<RotateCcw className="h-3.5 w-3.5" />}
          onClick={handleOpen}
        >
          Сбросить бота
        </Button>
      </div>

      <ApiErrorAlert error={resetMut.error} />

      {/* Модальное окно подтверждения сброса */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs">
          <div className="w-full max-w-md bg-ui-surface border border-ui-border rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-ui-text flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-ui-danger" />
                Подтверждение сброса
              </h3>
              <button
                type="button"
                onClick={handleClose}
                disabled={resetMut.isPending}
                className="text-ui-muted hover:text-ui-text p-1 rounded-lg"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm text-ui-muted">
              Это действие очистит настройки и активные FSM-сессии в боте. Чтобы подтвердить,
              введите <span className="font-mono font-semibold text-ui-text">{targetPhrase}</span>:
            </p>

            <input
              type="text"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={targetPhrase}
              disabled={resetMut.isPending}
              className="w-full px-3.5 py-2.5 bg-ui-subtle border border-ui-border rounded-xl text-sm font-mono text-ui-text focus:outline-hidden focus:ring-2 focus:ring-ui-danger"
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleClose}
                disabled={resetMut.isPending}
              >
                Отмена
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => resetMut.mutate()}
                disabled={!isConfirmed || resetMut.isPending}
                isLoading={resetMut.isPending}
              >
                Сбросить настройки
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
