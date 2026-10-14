import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  TrendingUp,
  CreditCard,
  Bot,
  Receipt,
  Users,
  CalendarCheck,
  Clock,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import { getDashboardMetrics } from "../api/analytics.js";
import { StatusBadge } from "../components/common/Badge.js";
import { Alert } from "../components/common/Alert.js";

export function DashboardPage() {
  const { data: metrics, isLoading, error } = useQuery({
    queryKey: ["dashboard-metrics"],
    queryFn: getDashboardMetrics,
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-slate-800 rounded-lg" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-32 bg-slate-900 border border-slate-800 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <Alert type="error" title="Ошибка загрузки аналитики">
        Не удалось получить данные дашборда. Проверьте соединение с сервером.
      </Alert>
    );
  }

  const formatUzs = (val: number) =>
    new Intl.NumberFormat("ru-RU", { style: "currency", currency: "UZS", maximumFractionDigits: 0 }).format(val);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Сводная аналитика платформы</h1>
        <p className="text-xs text-slate-400 mt-1">
          Финансовые показатели, статус ботов и операционный мониторинг
        </p>
      </div>

      {(metrics.inboxErrors24hCount || 0) > 0 && (
        <Alert type="warning" title="Внимание: ошибки обработки вебхуков">
          За последние 24 часа зафиксировано {metrics.inboxErrors24hCount} ошибок доставки Telegram Webhook.
          Проверьте раздел «Боты» → «Диагностика».
        </Alert>
      )}

      {/* Финансовые KPI */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl space-y-2">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-medium">Нормализованный MRR</span>
            <div className="p-2 bg-indigo-500/10 text-indigo-400 rounded-xl">
              <TrendingUp className="h-4 w-4" />
            </div>
          </div>
          <p className="text-2xl font-bold text-white tracking-tight">{formatUzs(metrics.mrrUzs || 0)}</p>
          <p className="text-[11px] text-slate-500">Без учета разовой настройки</p>
        </div>

        <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl space-y-2">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-medium">Выручка за месяц</span>
            <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-xl">
              <CreditCard className="h-4 w-4" />
            </div>
          </div>
          <p className="text-2xl font-bold text-emerald-400 tracking-tight">
            {formatUzs(metrics.cashCollectedThisMonthUzs || 0)}
          </p>
          <p className="text-[11px] text-slate-500">Фактически подтвержденные чеки</p>
        </div>

        <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl space-y-2">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-medium">Боты на платформе</span>
            <div className="p-2 bg-sky-500/10 text-sky-400 rounded-xl">
              <Bot className="h-4 w-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">{metrics.totalBots || 0}</span>
            <span className="text-xs text-emerald-400">({metrics.activePayingBots || 0} платящих)</span>
          </div>
          <p className="text-[11px] text-slate-500">{metrics.trialBots || 0} ботов на триале</p>
        </div>

        <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl space-y-2">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-medium">Очередь чеков</span>
            <div className={`p-2 rounded-xl ${(metrics.pendingReceiptsCount || 0) > 0 ? "bg-amber-500/10 text-amber-400 animate-pulse" : "bg-slate-800 text-slate-400"}`}>
              <Receipt className="h-4 w-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl font-bold ${(metrics.pendingReceiptsCount || 0) > 0 ? "text-amber-400" : "text-white"}`}>
              {metrics.pendingReceiptsCount || 0}
            </span>
            <span className="text-xs text-slate-500">на модерации</span>
          </div>
          {(metrics.pendingReceiptsCount || 0) > 0 ? (
            <Link to="/receipts" className="text-[11px] text-amber-400 hover:underline flex items-center gap-1 font-medium">
              Перейти к проверке <ArrowRight className="h-3 w-3" />
            </Link>
          ) : (
            <p className="text-[11px] text-slate-500">Все чеки обработаны</p>
          )}
        </div>
      </div>

      {/* Дополнительные счетчики */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 bg-slate-900/60 border border-slate-800/80 rounded-2xl flex items-center gap-4">
          <div className="p-3 bg-violet-500/10 text-violet-400 rounded-xl">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <p className="text-lg font-bold text-white">{metrics.totalLeadsCount || 0}</p>
            <p className="text-xs text-slate-400">Собрано заявок (LeadCatch)</p>
          </div>
        </div>

        <div className="p-4 bg-slate-900/60 border border-slate-800/80 rounded-2xl flex items-center gap-4">
          <div className="p-3 bg-indigo-500/10 text-indigo-400 rounded-xl">
            <CalendarCheck className="h-5 w-5" />
          </div>
          <div>
            <p className="text-lg font-bold text-white">{metrics.totalBookingsCount || 0}</p>
            <p className="text-xs text-slate-400">Оформлено записей (QuickBook)</p>
          </div>
        </div>

        <div className="p-4 bg-slate-900/60 border border-slate-800/80 rounded-2xl flex items-center gap-4">
          <div className="p-3 bg-rose-500/10 text-rose-400 rounded-xl">
            <Clock className="h-5 w-5" />
          </div>
          <div>
            <p className="text-lg font-bold text-white">{metrics.expiringIn3DaysCount || 0}</p>
            <p className="text-xs text-slate-400">Истекают в ближайшие 3 дня</p>
          </div>
        </div>
      </div>

      {/* Список ботов */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Боты и операционная активность</h2>
          <Link to="/bots" className="text-xs text-indigo-400 hover:text-indigo-300 font-medium flex items-center gap-1">
            Все боты <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/40 text-slate-400 border-b border-slate-800 font-medium">
              <tr>
                <th className="px-5 py-3">Бот / Арендатор</th>
                <th className="px-5 py-3">Тип</th>
                <th className="px-5 py-3">Статус</th>
                <th className="px-5 py-3">Лиды / Записи</th>
                <th className="px-5 py-3 text-right">Действие</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {(metrics.botsBreakdown || []).map((b) => (
                <tr key={b.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="px-5 py-3.5">
                    <p className="font-semibold text-white">{b.botUsername ? `@${b.botUsername}` : b.id.slice(0, 8)}</p>
                    <p className="text-[11px] text-slate-500">{b.tenantName}</p>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="font-mono text-[11px]">{b.botType}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="px-5 py-3.5 font-medium">
                    {b.botType === "LEADCATCH" ? `${b.leadsCount} лидов` : `${b.bookingsCount} записей`}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <Link
                      to={`/bots/${b.id}`}
                      className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300 font-medium"
                    >
                      Настроить <ExternalLink className="h-3 w-3" />
                    </Link>
                  </td>
                </tr>
              ))}
              {(!metrics.botsBreakdown || metrics.botsBreakdown.length === 0) && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-slate-500">
                    Боты еще не созданы. Перейдите в раздел «Арендаторы» для подключения.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
