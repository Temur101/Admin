import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getBotLeads, type BotDetails } from "../../api/bots.js";

const STATUS_LABELS: Record<string, string> = {
  ALL: "Все",
  NEW: "Новые",
  IN_PROGRESS: "В работе",
  DONE: "Выполнено",
  REJECTED: "Отклонено",
};

export function BotLeadsTab({ bot }: { bot: BotDetails }) {
  const [statusFilter, setStatusFilter] = useState<string>("ALL");

  const { data: leads = [], isLoading } = useQuery({
    queryKey: ["bot-leads", bot.id, statusFilter],
    queryFn: () => getBotLeads(bot.id, statusFilter),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ui-text">Заявки LeadCatch</h3>
          <p className="text-sm text-ui-muted mt-0.5">
            Статус обработки и ответственный менеджер по каждой заявке
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(STATUS_LABELS).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatusFilter(key)}
              className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                statusFilter === key
                  ? "bg-ui-accent text-ui-on-accent border-ui-accent"
                  : "bg-ui-surface text-ui-secondary border-ui-border hover:bg-ui-hover"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-ui-surface border border-ui-border rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-ui-subtle text-ui-muted border-b border-ui-border font-medium">
              <tr>
                <th className="px-4 py-3">Клиент</th>
                <th className="px-4 py-3">Телефон</th>
                <th className="px-4 py-3">Статус</th>
                <th className="px-4 py-3">Ответственный</th>
                <th className="px-4 py-3">Дата</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ui-border text-ui-secondary">
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-ui-muted">
                    Загрузка заявок...
                  </td>
                </tr>
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-ui-muted">
                    Заявок с выбранным статусом нет.
                  </td>
                </tr>
              ) : (
                leads.map((lead) => (
                  <tr key={lead.id} className="hover:bg-ui-hover transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-ui-text">{lead.customerName || "—"}</div>
                      {lead.customerUsername && (
                        <div className="text-xs text-ui-muted">@{lead.customerUsername}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {lead.phoneRaw}{" "}
                      <span className="text-ui-muted">
                        {lead.phoneVerified ? "(подтв.)" : "(вручную)"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex px-2 py-0.5 rounded-md text-xs font-medium bg-ui-subtle border border-ui-border">
                        {STATUS_LABELS[lead.status] ?? lead.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ui-text">{lead.assigneeName || "—"}</td>
                    <td className="px-4 py-3 text-xs text-ui-muted">
                      {new Date(lead.createdAt).toLocaleString("ru-RU")}
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
