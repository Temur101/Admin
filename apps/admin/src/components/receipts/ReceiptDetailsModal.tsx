import { useEffect, useState } from "react";
import type { ReceiptItem } from "../../api/receipts.js";
import { getReceiptImageUrl } from "../../api/receipts.js";
import { getStoredToken } from "../../api/client.js";
import { formatPlatformDate } from "../../utils/dates.js";
import { Modal } from "../common/Modal.js";
import { Alert } from "../common/Alert.js";

export function ReceiptDetailsModal({
  receipt,
  onClose,
}: {
  receipt: ReceiptItem;
  onClose: () => void;
}) {
  const token = getStoredToken();
  const [failedImage, setFailedImage] = useState(false);
  const [imageSrc, setImageSrc] = useState<string | undefined>(() =>
    token ? undefined : getReceiptImageUrl(receipt.id),
  );

  useEffect(() => {
    if (receipt.kind !== "PHOTO" || !token) return;
    let revoked = false;
    let objectUrl: string | undefined;

    fetch(getReceiptImageUrl(receipt.id), {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Status ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (revoked) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setImageSrc(url);
      })
      .catch(() => {
        if (!revoked) {
          setFailedImage(true);
        }
      });

    return () => {
      revoked = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [receipt.id, receipt.kind, token]);

  return (
    <Modal isOpen onClose={onClose} title="Детали оплаты" maxWidth="2xl">
      <div className="space-y-4">
        <p className="text-sm text-ui-secondary">
          {receipt.tenantName} · {receipt.amount.toLocaleString("ru-RU")} UZS · {receipt.months}{" "}
          мес.
        </p>
        <p className="text-sm text-ui-muted">
          Отправлено (Ташкент): {formatPlatformDate(receipt.createdAt)} · Telegram ID:{" "}
          {receipt.submittedByTgId}
        </p>
        {receipt.kind === "PHOTO" &&
          (failedImage ? (
            <Alert type="error">
              Не удалось загрузить изображение. Обновите страницу и откройте чек заново.
            </Alert>
          ) : (
            <img
              src={imageSrc}
              alt="Чек оплаты"
              onError={() => setFailedImage(true)}
              className="max-h-[60vh] mx-auto object-contain rounded-xl"
            />
          ))}
        <div className="space-y-2">
          <h3 className="font-semibold">
            {receipt.kind === "TEXT" ? "Текст клиента" : "Комментарий к чеку"}
          </h3>
          <p className="p-4 rounded-xl bg-ui-subtle border border-ui-border whitespace-pre-wrap break-words text-sm">
            {receipt.textNote || "Текст не указан."}
          </p>
        </div>
        {receipt.rejectionReason && (
          <Alert type="warning" title="Причина отклонения">
            {receipt.rejectionReason}
          </Alert>
        )}
        {receipt.reviewedAt && (
          <p className="text-sm text-ui-muted">
            Обработано (Ташкент): {formatPlatformDate(receipt.reviewedAt)}
          </p>
        )}
      </div>
    </Modal>
  );
}
