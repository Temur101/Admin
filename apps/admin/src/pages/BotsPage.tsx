import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, Bot, ExternalLink } from "lucide-react";
import { getBots } from "../api/bots.js";
import { getTenants } from "../api/tenants.js";
import { Button } from "../components/common/Button.js";
import { StatusBadge } from "../components/common/Badge.js";
import { Alert } from "../components/common/Alert.js";
import { CreateBotModal } from "../components/bots/CreateBotModal.js";

export function BotsPage() {
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const { data: bots = [], isLoading, error } = useQuery({
    queryKey: ["bots"],
    queryFn: getBots,
  });

  const { data: tenants = [] } = useQuery({
    queryKey: ["tenants"],
    queryFn: getTenants,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Подключенные боты</h1>
          <p className="text-xs text-slate-400 mt-1">
            Управление экземплярами LeadCatch и QuickBook для всех клиентов
          </p>
        </div>
        <Button
          onClick={() => setIsCreateOpen(true)}
          variant="primary"
          icon={<Plus className="h-4 w-4" />}
        >
          Подключить бота
        </Button>
      </div>

      {error && (
        <Alert type="error" title="Ошибка загрузки">
          Не удалось получить список ботов.
        </Alert>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/40 text-slate-400 border-b border-slate-800 font-medium">
              <tr>
                <th className="px-5 py-3">Бот / Username</th>
                <th className="px-5 py-3">Клиент</th>
                <th className="px-5 py-3">Тип</th>
                <th className="px-5 py-3">Статус подписки</th>
                <th className="px-5 py-3">Лиды / Записи</th>
                <th className="px-5 py-3">Админы</th>
                <th className="px-5 py-3 text-right">Управление</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-slate-500">
                    Загрузка ботов...
                  </td>
                </tr>
              ) : bots.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-slate-500">
                    Боты еще не зарегистрированы. Нажмите «Подключить бота».
                  </td>
                </tr>
              ) : (
                bots.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div className="h-8 w-8 rounded-lg bg-indigo-600/10 text-indigo-400 flex items-center justify-center shrink-0">
                          <Bot className="h-4 w-4" />
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`inline-block h-2 w-2 rounded-full ${
                                b.isActive ? "bg-emerald-500 animate-pulse" : "bg-rose-500"
                              }`}
                              title={b.isActive ? "Бот онлайн" : "Приостановлен"}
                            />
                            {b.botUsername ? (
                              <a
                                href={`https://t.me/${b.botUsername}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-semibold text-white hover:text-indigo-300 transition-colors inline-flex items-center gap-1"
                              >
                                @{b.botUsername}
                                <ExternalLink className="h-2.5 w-2.5 opacity-60" />
                              </a>
                            ) : (
                              <span className="font-semibold text-white">{b.id.slice(0, 8)}</span>
                            )}
                          </div>
                          <p className="text-[10px] text-slate-500 font-mono">{b.id.slice(0, 8)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 font-medium text-slate-300">{b.tenantName}</td>
                    <td className="px-5 py-3.5">
                      <span className="font-mono text-[11px] bg-slate-800 px-2 py-0.5 rounded-md border border-slate-700">
                        {b.botType}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={b.subscription?.status || (b.isActive ? "ACTIVE" : "SUSPENDED")} />
                    </td>
                    <td className="px-5 py-3.5 font-medium">
                      {b.botType === "LEADCATCH" ? `${b.stats.leadsCount} заявок` : `${b.stats.bookingsCount} записей`}
                    </td>
                    <td className="px-5 py-3.5 text-slate-400">{b.stats.usersCount} чел</td>
                    <td className="px-5 py-3.5 text-right">
                      <Link
                        to={`/bots/${b.id}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-indigo-300 text-xs font-medium transition-colors"
                      >
                        Настроить <ExternalLink className="h-3 w-3" />
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <CreateBotModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        tenants={tenants}
      />
    </div>
  );
}
