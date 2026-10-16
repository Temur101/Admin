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
  const {
    data: metrics,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["dashboard-metrics"],
    queryFn: getDashboardMetrics,
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-ui-hover rounded-lg" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-32 bg-ui-surface border border-ui-border rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <Alert type="error" title="Ошибка загрузки аналитики">
        Не удалось получить данные обзора. Проверьте соединение с сервером.
      </Alert>
    );
  }

  const formatUzs = (val: number) =>
    new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: "UZS",
      maximumFractionDigits: 0,
    }).format(val);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-ui-text tracking-tight">
          Сводная аналитика платформы
        </h1>
        <p className="text-sm text-ui-muted mt-1">
          Финансовые показатели, статус ботов и операционный мониторинг
        </p>
      </div>

      {(metrics.inboxErrors24hCount || 0) > 0 && (
        <Alert type="warning" title="Внимание: ошибки обработки вебхуков">
          За последние 24 часа зафиксировано {metrics.inboxErrors24hCount} ошибок доставки Telegram
          Webhook. Проверьте раздел «Боты» → «Диагностика».
        </Alert>
      )}

      {/* Финансовые KPI */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 bg-ui-surface border border-ui-border rounded-2xl space-y-2">
          <div className="flex items-center justify-between text-ui-muted">
            <span className="text-sm font-medium">Доход от подписок / месяц</span>
            <div className="p-2 bg-ui-accent-soft text-ui-accent rounded-xl">
              <TrendingUp className="h-4 w-4" />
            </div>
          </div>
          <p className="text-2xl font-bold text-ui-text tracking-tight">
            {formatUzs(metrics.mrrUzs || 0)}
          </p>
          <p className="text-sm text-ui-muted">Без учета разовой настройки</p>
        </div>

        <div className="p-5 bg-ui-surface border border-ui-border rounded-2xl space-y-2">
          <div className="flex items-center justify-between text-ui-muted">
            <span className="text-sm font-medium">Выручка за месяц</span>
            <div className="p-2 bg-ui-success-soft text-ui-success rounded-xl">
              <CreditCard className="h-4 w-4" />
            </div>
          </div>
          <p className="text-2xl font-bold text-ui-success tracking-tight">
            {formatUzs(metrics.cashCollectedThisMonthUzs || 0)}
          </p>
          <p className="text-sm text-ui-muted">Фактически подтвержденные чеки</p>
        </div>

        <div className="p-5 bg-ui-surface border border-ui-border rounded-2xl space-y-2">
          <div className="flex items-center justify-between text-ui-muted">
            <span className="text-sm font-medium">Боты на платформе</span>
            <div className="p-2 bg-ui-info-soft text-ui-info rounded-xl">
              <Bot className="h-4 w-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-ui-text">{metrics.totalBots || 0}</span>
            <span className="text-sm text-ui-success">
              ({metrics.activePayingBots || 0} платящих)
            </span>
          </div>
          <p className="text-sm text-ui-muted">{metrics.trialBots || 0} ботов на триале</p>
        </div>

        <div className="p-5 bg-ui-surface border border-ui-border rounded-2xl space-y-2">
          <div className="flex items-center justify-between text-ui-muted">
            <span className="text-sm font-medium">Очередь чеков</span>
            <div
              className={`p-2 rounded-xl ${(metrics.pendingReceiptsCount || 0) > 0 ? "bg-ui-warning-soft text-ui-warning animate-pulse" : "bg-ui-hover text-ui-muted"}`}
            >
              <Receipt className="h-4 w-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span
              className={`text-2xl font-bold ${(metrics.pendingReceiptsCount || 0) > 0 ? "text-ui-warning" : "text-ui-text"}`}
            >
              {metrics.pendingReceiptsCount || 0}
            </span>
            <span className="text-sm text-ui-muted">на модерации</span>
          </div>
          {(metrics.pendingReceiptsCount || 0) > 0 ? (
            <Link
              to="/receipts"
              className="text-sm text-ui-warning hover:underline flex items-center gap-1 font-medium"
            >
              Перейти к проверке <ArrowRight className="h-3 w-3" />
            </Link>
          ) : (
            <p className="text-sm text-ui-muted">Все чеки обработаны</p>
          )}
        </div>
      </div>

      {/* Дополнительные счетчики */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 bg-ui-surface border border-ui-border rounded-2xl flex items-center gap-4">
          <div className="p-3 bg-ui-accent-soft text-ui-accent rounded-xl">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <p className="text-lg font-bold text-ui-text">{metrics.totalLeadsCount || 0}</p>
            <p className="text-sm text-ui-muted">Собрано заявок (LeadCatch)</p>
          </div>
        </div>

        <div className="p-4 bg-ui-surface border border-ui-border rounded-2xl flex items-center gap-4">
          <div className="p-3 bg-ui-accent-soft text-ui-accent rounded-xl">
            <CalendarCheck className="h-5 w-5" />
          </div>
          <div>
            <p className="text-lg font-bold text-ui-text">{metrics.totalBookingsCount || 0}</p>
            <p className="text-sm text-ui-muted">Оформлено записей (QuickBook)</p>
          </div>
        </div>

        <div className="p-4 bg-ui-surface border border-ui-border rounded-2xl flex items-center gap-4">
          <div className="p-3 bg-ui-danger-soft text-ui-danger rounded-xl">
            <Clock className="h-5 w-5" />
          </div>
          <div>
            <p className="text-lg font-bold text-ui-text">{metrics.expiringIn3DaysCount || 0}</p>
            <p className="text-sm text-ui-muted">Истекают в ближайшие 3 дня</p>
          </div>
        </div>
      </div>

      {/* Список ботов */}
      <div className="bg-ui-surface border border-ui-border rounded-2xl overflow-hidden shadow-sm">
        <div className="p-5 border-b border-ui-border flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ui-text">Боты и операционная активность</h2>
          <Link
            to="/bots"
            className="text-sm text-ui-accent hover:text-ui-accent-hover font-medium flex items-center gap-1"
          >
            Все боты <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-ui-subtle text-ui-muted border-b border-ui-border font-medium">
              <tr>
                <th className="px-5 py-3">Бот / Клиент</th>
                <th className="px-5 py-3">Тип</th>
                <th className="px-5 py-3">Статус</th>
                <th className="px-5 py-3">Лиды / Записи</th>
                <th className="px-5 py-3 text-right">Действие</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ui-border text-ui-secondary">
              {(metrics.botsBreakdown || []).map((b) => (
                <tr key={b.id} className="hover:bg-ui-hover transition-colors">
                  <td className="px-5 py-3.5">
                    <p className="font-semibold text-ui-text">
                      {b.botUsername ? `@${b.botUsername}` : b.id.slice(0, 8)}
                    </p>
                    <p className="text-sm text-ui-muted">{b.tenantName}</p>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="font-mono text-sm">{b.botType}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="px-5 py-3.5 font-medium">
                    {b.botType === "LEADCATCH"
                      ? `${b.leadsCount} лидов`
                      : `${b.bookingsCount} записей`}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <Link
                      to={`/bots/${b.id}`}
                      className="inline-flex items-center gap-1 text-ui-accent hover:text-ui-accent-hover font-medium"
                    >
                      Настроить <ExternalLink className="h-3 w-3" />
                    </Link>
                  </td>
                </tr>
              ))}
              {(!metrics.botsBreakdown || metrics.botsBreakdown.length === 0) && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-ui-muted">
                    Боты еще не созданы. Перейдите в раздел «Клиенты» для подключения.
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
