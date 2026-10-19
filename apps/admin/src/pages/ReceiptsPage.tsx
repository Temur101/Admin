import { ReceiptDetailsModal } from "../components/receipts/ReceiptDetailsModal.js";
import { ApiErrorAlert } from "../components/common/ApiErrorAlert.js";
import { formatPlatformDate } from "../utils/dates.js";
import { ApiError } from "../api/client.js";
import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X, FileText, Image } from "lucide-react";
import { getReceipts, approveReceipt, rejectReceipt, type ReceiptItem } from "../api/receipts.js";
import { Button } from "../components/common/Button.js";
import { Modal } from "../components/common/Modal.js";
import { StatusBadge } from "../components/common/Badge.js";
import { Alert } from "../components/common/Alert.js";
import { Textarea } from "../components/common/Input.js";

export function ReceiptsPage() {
  const queryClient = useQueryClient();
  const [activeStatus, setActiveStatus] = useState<string>("PENDING");
  const [selectedReceipt, setSelectedReceipt] = useState<ReceiptItem | null>(null);
  const [rejectItem, setRejectItem] = useState<ReceiptItem | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  const {
    data: receipts = [],
    isLoading,
    isFetching,
    refetch,
    error,
  } = useQuery({
    queryKey: ["receipts", activeStatus],
    queryFn: () => getReceipts(activeStatus),
    refetchInterval: 15000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["receipts"] });
    void queryClient.invalidateQueries({ queryKey: ["pending-receipts-count"] });
    for (const key of ["bots", "bot", "bot-health", "dashboard-metrics"])
      void queryClient.invalidateQueries({ queryKey: [key] });
  };

  const handleActionError = (err: Error) => {
    if (err instanceof ApiError && err.statusCode === 409) invalidate();
  };
  const approveMut = useMutation({
    mutationFn: (id: string) => approveReceipt(id),
    onSuccess: () => {
      invalidate();
      setActionFeedback("Оплата подтверждена. Данные подписки обновлены.");
    },
    onError: handleActionError,
  });

  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => rejectReceipt(id, { reason }),
    onSuccess: () => {
      invalidate();
      setRejectItem(null);
      setRejectReason("");
      setActionFeedback("Чек отклонен, срок подписки скорректирован.");
    },
    onError: handleActionError,
  });

  const handleApprove = (r: ReceiptItem) => {
    if (confirm(`Одобрить оплату ${r.amount.toLocaleString("ru-RU")} UZS от ${r.tenantName}?`)) {
      setActionFeedback(null);
      rejectMut.reset();
      approveMut.mutate(r.id);
    }
  };

  const handleRejectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectItem || !rejectReason.trim()) return;
    rejectMut.mutate({ id: rejectItem.id, reason: rejectReason.trim() });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ui-text tracking-tight">
          Модерация платежных чеков
        </h1>
        <p className="text-sm text-ui-muted mt-1">
          Проверка чеков оплаты от клиентов, подтверждение или отказ с автоматическим уведомлением в
          Telegram
        </p>
      </div>

      {actionFeedback && (
        <Alert type="success" title="Результат">
          {actionFeedback}
        </Alert>
      )}

      <ApiErrorAlert error={error || approveMut.error || (!rejectItem && rejectMut.error)} />
      {error && (
        <Button variant="outline" isLoading={isFetching} onClick={() => void refetch()}>
          Повторить загрузку
        </Button>
      )}
      {/* Фильтры статусов */}
      <div className="flex flex-wrap gap-2">
        {["PENDING", "APPROVED", "REJECTED"].map((st) => (
          <button
            key={st}
            onClick={() => setActiveStatus(st)}
            className={`px-3.5 py-1.5 rounded-xl text-sm font-medium transition-all cursor-pointer ${
              activeStatus === st
                ? "bg-ui-accent text-ui-on-accent shadow-sm"
                : "bg-ui-surface border border-ui-border text-ui-muted hover:text-ui-text"
            }`}
          >
            {st === "PENDING"
              ? "Ожидают проверки"
              : st === "APPROVED"
                ? "Одобренные"
                : "Отклоненные"}
          </button>
        ))}
      </div>

      {/* Список чеков */}
      <div className="bg-ui-surface border border-ui-border rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-ui-subtle text-ui-muted border-b border-ui-border font-medium">
              <tr>
                <th className="px-5 py-3">Клиент / Бот</th>
                <th className="px-5 py-3">Тип чека</th>
                <th className="px-5 py-3">Тариф / Срок</th>
                <th className="px-5 py-3">Сумма</th>
                <th className="px-5 py-3">Статус</th>
                <th className="px-5 py-3">Дата отправки</th>
                <th className="px-5 py-3 text-right">Модерация</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ui-border text-ui-secondary">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-ui-muted">
                    Загрузка чеков...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-ui-muted">
                    Не удалось загрузить список чеков.
                  </td>
                </tr>
              ) : receipts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-ui-muted">
                    Чеки с выбранным статусом отсутствуют.
                  </td>
                </tr>
              ) : (
                receipts.map((r) => (
                  <tr key={r.id} className="hover:bg-ui-hover transition-colors">
                    <td className="px-5 py-3.5">
                      <p className="font-semibold text-ui-text">{r.tenantName}</p>
                      <p className="text-sm text-ui-muted">
                        {r.botUsername ? `@${r.botUsername}` : r.botId.slice(0, 8)} ({r.botType})
                      </p>
                    </td>
                    <td className="px-5 py-3.5">
                      {r.kind === "PHOTO" ? (
                        <button
                          onClick={() => setSelectedReceipt(r)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-ui-info-soft text-ui-info border border-ui-info-border hover:bg-ui-info-soft transition-colors cursor-pointer"
                        >
                          <Image className="h-3.5 w-3.5" />
                          <span>Скриншот</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => setSelectedReceipt(r)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-ui-info-border text-ui-info bg-ui-info-soft"
                        >
                          <FileText className="h-3.5 w-3.5" />
                          <span>Открыть текст</span>
                        </button>
                      )}
                    </td>
                    <td className="px-5 py-3.5 font-medium text-ui-secondary">
                      {r.months} {r.months === 1 ? "месяц" : "месяцев"}
                    </td>
                    <td className="px-5 py-3.5 font-semibold text-ui-text font-mono">
                      {r.amount.toLocaleString("ru-RU")} UZS
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-5 py-3.5 text-ui-muted">{formatPlatformDate(r.createdAt)}</td>
                    <td className="px-5 py-3.5 text-right">
                      {r.status === "PENDING" ? (
                        <div className="flex justify-end gap-1.5">
                          <Button
                            variant="primary"
                            size="sm"
                            className="bg-ui-success hover:bg-ui-success border-ui-success-border"
                            onClick={() => handleApprove(r)}
                            isLoading={approveMut.isPending}
                            disabled={rejectMut.isPending}
                            icon={<Check className="h-3.5 w-3.5" />}
                          >
                            Одобрить
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              setRejectItem(r);
                              setRejectReason("");
                              setActionFeedback(null);
                              rejectMut.reset();
                              approveMut.reset();
                            }}
                            disabled={approveMut.isPending || rejectMut.isPending}
                            icon={<X className="h-3.5 w-3.5" />}
                          >
                            Отклонить
                          </Button>
                        </div>
                      ) : (
                        <span className="text-sm text-ui-muted">Обработан</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedReceipt && (
        <ReceiptDetailsModal
          key={selectedReceipt.id}
          receipt={selectedReceipt}
          onClose={() => setSelectedReceipt(null)}
        />
      )}

      {/* Модалка указания причины отклонения */}
      <Modal
        isOpen={!!rejectItem}
        onClose={() => {
          if (!rejectMut.isPending) setRejectItem(null);
        }}
        title="Отклонение чека оплаты"
        description="Укажите причину отказа. Она будет отправлена клиенту в Telegram."
      >
        <form onSubmit={handleRejectSubmit} className="space-y-4">
          <ApiErrorAlert error={rejectMut.error} />
          <Textarea
            label="Причина отклонения чека"
            placeholder="Например: Платеж не поступил на карту или чек не читаем..."
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            required
            maxLength={500}
            disabled={rejectMut.isPending}
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              type="button"
              disabled={rejectMut.isPending}
              onClick={() => setRejectItem(null)}
            >
              Отмена
            </Button>
            <Button variant="danger" type="submit" isLoading={rejectMut.isPending}>
              Отклонить чек
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
