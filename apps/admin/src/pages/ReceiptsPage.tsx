import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X, FileText, Image } from "lucide-react";
import {
  getReceipts,
  approveReceipt,
  rejectReceipt,
  getReceiptImageUrl,
  type ReceiptItem,
} from "../api/receipts.js";
import { Button } from "../components/common/Button.js";
import { Modal } from "../components/common/Modal.js";
import { StatusBadge } from "../components/common/Badge.js";
import { Alert } from "../components/common/Alert.js";
import { Textarea } from "../components/common/Input.js";

export function ReceiptsPage() {
  const queryClient = useQueryClient();
  const [activeStatus, setActiveStatus] = useState<string>("PENDING");
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [rejectItem, setRejectItem] = useState<ReceiptItem | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  const { data: receipts = [], isLoading } = useQuery({
    queryKey: ["receipts", activeStatus],
    queryFn: () => getReceipts(activeStatus),
    refetchInterval: 15000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["receipts"] });
    void queryClient.invalidateQueries({ queryKey: ["pending-receipts-count"] });
  };

  const approveMut = useMutation({
    mutationFn: (id: string) => approveReceipt(id),
    onSuccess: () => {
      invalidate();
      setActionFeedback("Чек успешно одобрен. Подписка бота активирована.");
    },
  });

  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectReceipt(id, { reason }),
    onSuccess: () => {
      invalidate();
      setRejectItem(null);
      setRejectReason("");
      setActionFeedback("Чек отклонен, срок подписки скорректирован.");
    },
  });

  const handleApprove = (r: ReceiptItem) => {
    if (confirm(`Одобрить оплату ${r.amount.toLocaleString("ru-RU")} UZS от ${r.tenantName}?`)) {
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
        <h1 className="text-2xl font-bold text-white tracking-tight">Модерация платежных чеков</h1>
        <p className="text-xs text-slate-400 mt-1">
          Проверка чеков оплаты от арендаторов, подтверждение или отказ с автоматическим уведомлением в Telegram
        </p>
      </div>

      {actionFeedback && (
        <Alert type="success" title="Результат">
          {actionFeedback}
        </Alert>
      )}

      {/* Фильтры статусов */}
      <div className="flex gap-2">
        {["PENDING", "APPROVED", "REJECTED"].map((st) => (
          <button
            key={st}
            onClick={() => setActiveStatus(st)}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
              activeStatus === st
                ? "bg-indigo-600 text-white shadow-sm"
                : "bg-slate-900 border border-slate-800 text-slate-400 hover:text-white"
            }`}
          >
            {st === "PENDING" ? "Ожидают проверки" : st === "APPROVED" ? "Одобренные" : "Отклоненные"}
          </button>
        ))}
      </div>

      {/* Список чеков */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/40 text-slate-400 border-b border-slate-800 font-medium">
              <tr>
                <th className="px-5 py-3">Арендатор / Бот</th>
                <th className="px-5 py-3">Тип чека</th>
                <th className="px-5 py-3">Тариф / Срок</th>
                <th className="px-5 py-3">Сумма</th>
                <th className="px-5 py-3">Статус</th>
                <th className="px-5 py-3">Дата отправки</th>
                <th className="px-5 py-3 text-right">Модерация</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-slate-500">
                    Загрузка чеков...
                  </td>
                </tr>
              ) : receipts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-slate-500">
                    Чеки с выбранным статусом отсутствуют.
                  </td>
                </tr>
              ) : (
                receipts.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="px-5 py-3.5">
                      <p className="font-semibold text-white">{r.tenantName}</p>
                      <p className="text-[11px] text-slate-400">
                        {r.botUsername ? `@${r.botUsername}` : r.botId.slice(0, 8)} ({r.botType})
                      </p>
                    </td>
                    <td className="px-5 py-3.5">
                      {r.kind === "PHOTO" ? (
                        <button
                          onClick={() => setSelectedImage(getReceiptImageUrl(r.id))}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20 hover:bg-sky-500/20 transition-colors cursor-pointer"
                        >
                          <Image className="h-3.5 w-3.5" />
                          <span>Скриншот</span>
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-slate-400 font-mono">
                          <FileText className="h-3.5 w-3.5" />
                          <span>Текст</span>
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 font-medium text-slate-300">
                      {r.months} {r.months === 1 ? "месяц" : "месяцев"}
                    </td>
                    <td className="px-5 py-3.5 font-semibold text-white font-mono">
                      {r.amount.toLocaleString("ru-RU")} UZS
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-5 py-3.5 text-slate-500">
                      {new Date(r.createdAt).toLocaleString("ru-RU")}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      {r.status === "PENDING" ? (
                        <div className="flex justify-end gap-1.5">
                          <Button
                            variant="primary"
                            size="sm"
                            className="bg-emerald-600 hover:bg-emerald-500 border-emerald-500/30"
                            onClick={() => handleApprove(r)}
                            isLoading={approveMut.isPending}
                            icon={<Check className="h-3.5 w-3.5" />}
                          >
                            Одобрить
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => setRejectItem(r)}
                            icon={<X className="h-3.5 w-3.5" />}
                          >
                            Отклонить
                          </Button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-500">Обработан</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Модалка просмотра изображения */}
      <Modal
        isOpen={!!selectedImage}
        onClose={() => setSelectedImage(null)}
        title="Скриншот чека оплаты"
        maxWidth="2xl"
      >
        {selectedImage && (
          <div className="flex justify-center bg-slate-950 p-4 rounded-xl">
            <img
              src={selectedImage}
              alt="Чек оплаты"
              className="max-h-[70vh] object-contain rounded-lg"
            />
          </div>
        )}
      </Modal>

      {/* Модалка указания причины отклонения */}
      <Modal
        isOpen={!!rejectItem}
        onClose={() => setRejectItem(null)}
        title="Отклонение чека оплаты"
        description="Укажите причину отказа. Она будет отправлена клиенту в Telegram."
      >
        <form onSubmit={handleRejectSubmit} className="space-y-4">
          <Textarea
            label="Причина отклонения чека"
            placeholder="Например: Платеж не поступил на карту или чек не читаем..."
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            required
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" type="button" onClick={() => setRejectItem(null)}>
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
