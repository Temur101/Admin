import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Copy, Check } from "lucide-react";
import { createBot, type CreateBotResult } from "../../api/bots.js";
import type { TenantItem } from "../../api/tenants.js";
import { Button } from "../common/Button.js";
import { Modal } from "../common/Modal.js";
import { Input } from "../common/Input.js";
import { Alert } from "../common/Alert.js";

interface CreateBotModalProps {
  isOpen: boolean;
  onClose: () => void;
  tenants: TenantItem[];
}

export function CreateBotModal({ isOpen, onClose, tenants }: CreateBotModalProps) {
  const queryClient = useQueryClient();
  const [tenantId, setTenantId] = useState("");
  const [botType, setBotType] = useState<"LEADCATCH" | "QUICKBOOK">("LEADCATCH");
  const [botToken, setBotToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [createdResult, setCreatedResult] = useState<CreateBotResult | null>(null);
  const [copied, setCopied] = useState(false);

  const createMutation = useMutation({
    mutationFn: createBot,
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["bots"] });
      setCreatedResult(data);
      setBotToken("");
      setFormError(null);
    },
    onError: (err: Error) => {
      setFormError(err.message || "Ошибка подключения Telegram-бота");
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantId || !botToken.trim()) {
      setFormError("Выберите арендатора и укажите токен Telegram-бота");
      return;
    }
    createMutation.mutate({ tenantId, botType, botToken: botToken.trim() });
  };

  const handleCopyLink = (link: string) => {
    void navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = () => {
    setCreatedResult(null);
    setFormError(null);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={createdResult ? "Бот успешно подключен!" : "Подключение Telegram-бота"}
      description={createdResult ? "Бот зарегистрирован и готов к работе" : "Введите токен бота, полученный в @BotFather"}
    >
      {createdResult ? (
        <div className="space-y-4">
          {createdResult.warning ? (
            <Alert type="warning" title="Предупреждение webhook">
              {createdResult.warning}
            </Alert>
          ) : (
            <Alert type="success" title="Webhook настроен">
              Бот активирован с 14-дневным пробным периодом.
            </Alert>
          )}

          <div className="p-3 bg-slate-950/60 border border-slate-800 rounded-xl space-y-1.5 text-xs">
            <p className="font-semibold text-slate-200">Чеклист запуска:</p>
            <ol className="list-decimal list-inside space-y-1 text-slate-400 text-[11px]">
              <li>Перейдите в бота по ссылке-приглашению ниже</li>
              <li>Нажмите команду /start для привязки роли администратора</li>
              <li>Настройте сценарий во вкладке бота</li>
            </ol>
          </div>

          {createdResult.inviteLink && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-300">
                Ссылка-приглашение для администратора клиента:
              </label>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={createdResult.inviteLink}
                  className="flex-1 px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-slate-300"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleCopyLink(createdResult.inviteLink!)}
                  icon={copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                >
                  {copied ? "Скопировано" : "Копировать"}
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            {createdResult.botUsername && (
              <a
                href={createdResult.inviteLink || `https://t.me/${createdResult.botUsername}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-sky-500/10 text-sky-400 border border-sky-500/20 hover:bg-sky-500/20 text-xs font-medium transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Открыть в Telegram
              </a>
            )}
            <div className="ml-auto">
              <Button variant="primary" onClick={handleClose}>
                Готово
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <form onSubmit={handleCreate} className="space-y-4">
          {formError && (
            <Alert type="error" title="Ошибка">
              {formError}
            </Alert>
          )}

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">Арендатор (Клиент)</label>
            <select
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
              required
            >
              <option value="">-- Выберите арендатора --</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.clientName} ({t.contactPhone})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">Тип решения</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setBotType("LEADCATCH")}
                className={`p-3 rounded-xl border text-left cursor-pointer transition-all ${
                  botType === "LEADCATCH"
                    ? "border-indigo-500 bg-indigo-500/10 text-white"
                    : "border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700"
                }`}
              >
                <p className="font-semibold text-xs">LeadCatch</p>
                <p className="text-[10px] text-slate-500 mt-0.5">Опросники и лидогенерация</p>
              </button>
              <button
                type="button"
                onClick={() => setBotType("QUICKBOOK")}
                className={`p-3 rounded-xl border text-left cursor-pointer transition-all ${
                  botType === "QUICKBOOK"
                    ? "border-indigo-500 bg-indigo-500/10 text-white"
                    : "border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700"
                }`}
              >
                <p className="font-semibold text-xs">QuickBook</p>
                <p className="text-[10px] text-slate-500 mt-0.5">Онлайн-запись и слоты</p>
              </button>
            </div>
          </div>

          <Input
            label="Токен Telegram-бота (из @BotFather)"
            placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            required
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" type="button" onClick={handleClose}>
              Отмена
            </Button>
            <Button variant="primary" type="submit" isLoading={createMutation.isPending}>
              Подключить бота
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
