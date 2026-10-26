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

  const {
    data: bots = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["bots"],
    queryFn: getBots,
  });

  const { data: tenants = [] } = useQuery({
    queryKey: ["tenants"],
    queryFn: getTenants,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ui-text tracking-tight">Подключенные боты</h1>
          <p className="text-sm text-ui-muted mt-1">
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

      <div className="bg-ui-surface border border-ui-border rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-ui-subtle text-ui-muted border-b border-ui-border font-medium">
              <tr>
                <th className="px-5 py-3">Бот / Username</th>
                <th className="px-5 py-3">Клиент</th>
                <th className="px-5 py-3">Тип</th>
                <th className="px-5 py-3">Статус подписки</th>
                <th className="px-5 py-3">Лиды / Записи</th>
                <th className="px-5 py-3">Админы / Пользователи</th>
                <th className="px-5 py-3 text-right">Управление</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ui-border text-ui-secondary">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-ui-muted">
                    Загрузка ботов...
                  </td>
                </tr>
              ) : bots.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-ui-muted">
                    Боты еще не зарегистрированы. Нажмите «Подключить бота».
                  </td>
                </tr>
              ) : (
                bots.map((b) => (
                  <tr key={b.id} className="hover:bg-ui-hover transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div className="h-8 w-8 rounded-lg bg-ui-accent-soft text-ui-accent flex items-center justify-center shrink-0">
                          <Bot className="h-4 w-4" />
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`inline-block h-2 w-2 rounded-full ${
                                b.isActive ? "bg-ui-muted" : "bg-ui-danger"
                              }`}
                              title={
                                b.isActive
                                  ? "Бот включён; связь проверяется в карточке"
                                  : "Приостановлен"
                              }
                            />
                            {b.botUsername ? (
                              <a
                                href={`https://t.me/${b.botUsername}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-semibold text-ui-text hover:text-ui-accent-hover transition-colors inline-flex items-center gap-1"
                              >
                                @{b.botUsername}
                                <ExternalLink className="h-2.5 w-2.5 opacity-60" />
                              </a>
                            ) : (
                              <span className="font-semibold text-ui-text">{b.id.slice(0, 8)}</span>
                            )}
                          </div>
                          <p className="text-xs text-ui-muted font-mono">{b.id.slice(0, 8)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 font-medium text-ui-secondary">{b.tenantName}</td>
                    <td className="px-5 py-3.5">
                      <span className="font-mono text-sm bg-ui-hover px-2 py-0.5 rounded-md border border-ui-border">
                        {b.botType}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={b.subscription?.status || "UNKNOWN"} />
                    </td>
                    <td className="px-5 py-3.5 font-medium">
                      {b.botType === "LEADCATCH"
                        ? `${b.stats.leadsCount} заявок`
                        : `${b.stats.bookingsCount} записей`}
                    </td>
                    <td className="px-5 py-3.5 text-ui-muted">
                      {b.stats.adminsCount ?? 0} адм. · {b.stats.usersCount} польз.
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <Link
                        to={`/bots/${b.id}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-ui-hover hover:bg-ui-hover text-ui-accent text-sm font-medium transition-colors"
                      >
                        Настроить <ExternalLink className="h-3 w-3" />
                      </Link>
                      <Link
                        to={`/bots/${b.id}?setup=1`}
                        className="block mt-2 text-sm text-ui-accent"
                      >
                        Мастер запуска
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
