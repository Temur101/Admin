import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Copy, Check, UserX, Shield } from "lucide-react";
import type { BotDetails } from "../../api/bots.js";
import { getBotAdmins, reissueBotInvite, revokeBotAdmin } from "../../api/bots.js";
import { Button } from "../common/Button.js";
import { Alert } from "../common/Alert.js";

interface BotAdminsTabProps {
  bot: BotDetails;
}

export function BotAdminsTab({ bot }: BotAdminsTabProps) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const { data: admins = [], isLoading } = useQuery({
    queryKey: ["bot-admins", bot.id],
    queryFn: () => getBotAdmins(bot.id),
  });

  const reissueMut = useMutation({
    mutationFn: () => reissueBotInvite(bot.id),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["bot", bot.id] });
      setFeedback(`Инвайт-код перевыпущен: ${data.adminInviteCode}`);
    },
  });

  const revokeMut = useMutation({
    mutationFn: (tgId: string) => revokeBotAdmin(bot.id, tgId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["bot-admins", bot.id] });
      setFeedback("Права администратора отозваны.");
    },
  });

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Администраторы Telegram-бота</h3>
          <p className="text-xs text-slate-400 mt-1">
            Пользователи, имеющие доступ к просмотру лидов/записей и биллингу внутри Telegram
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={() => reissueMut.mutate()}
          isLoading={reissueMut.isPending}
        >
          Перевыпустить ссылку
        </Button>
      </div>

      {feedback && (
        <Alert type="info" title="Статус">
          {feedback}
        </Alert>
      )}

      {/* Инвайт ссылка */}
      {bot.inviteLink && (
        <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-2">
          <label className="text-xs font-medium text-slate-300">
            Актуальная ссылка для приглашения новых администраторов:
          </label>
          <div className="flex gap-2">
            <input
              readOnly
              value={bot.inviteLink}
              className="flex-1 px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-300"
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

      {/* Список админов */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/40 text-slate-400 border-b border-slate-800 font-medium">
              <tr>
                <th className="px-5 py-3">Имя / Telegram</th>
                <th className="px-5 py-3">Telegram ID</th>
                <th className="px-5 py-3">Дата назначения</th>
                <th className="px-5 py-3 text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {isLoading ? (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-slate-500">
                    Загрузка администраторов...
                  </td>
                </tr>
              ) : admins.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-slate-500">
                    Администраторы пока не подключились. Отправьте клиенту ссылку-приглашение выше.
                  </td>
                </tr>
              ) : (
                admins.map((a) => (
                  <tr key={a.tgId} className="hover:bg-slate-800/30 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <Shield className="h-3.5 w-3.5 text-indigo-400" />
                        <span className="font-semibold text-white">
                          {a.firstName || "(Без имени)"}
                        </span>
                        {a.username && (
                          <span className="text-slate-400">@{a.username}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 font-mono text-slate-400">{a.tgId}</td>
                    <td className="px-5 py-3.5 text-slate-500">
                      {new Date(a.createdAt).toLocaleDateString("ru-RU")}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-slate-400 hover:text-rose-400"
                        title="Отозвать права администратора"
                        onClick={() => {
                          if (confirm(`Отозвать роль администратора у ${a.firstName || a.tgId}?`)) {
                            revokeMut.mutate(a.tgId);
                          }
                        }}
                      >
                        <UserX className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
