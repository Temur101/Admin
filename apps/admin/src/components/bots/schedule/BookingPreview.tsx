import { useState } from "react";
import type { QuickBookConfig } from "@lcqb/contracts";
import { previewBookingTimes } from "../../../utils/booking-preview.js";
export function BookingPreview({ config }: { config: QuickBookConfig }) {
  const [serviceId, setServiceId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [day, setDay] = useState(1);
  const [lang, setLang] = useState<"ru" | "uz">("ru");
  const service = config.services.find((s) => s.id === serviceId) ?? config.services[0];
  const resource = config.resources.find((r) => r.id === resourceId) ?? config.resources[0];
  const slots = previewBookingTimes(config, service?.id ?? "", resource?.id ?? "", day);
  const style =
    "w-full min-w-0 min-h-11 rounded-xl border border-ui-border bg-ui-surface px-3 text-sm";
  return (
    <section
      aria-label="Предпросмотр записи"
      className="p-4 rounded-2xl border border-ui-border bg-ui-subtle space-y-4"
    >
      <div>
        <h4 className="font-semibold">Предпросмотр записи</h4>
        <p className="text-sm text-ui-muted mt-1">
          Показывает время по настроенному расписанию, без учёта реальных броней и текущей даты.
          Запись не создаётся.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="text-sm space-y-1">
          Язык предпросмотра
          <select
            className={style}
            value={lang}
            onChange={(e) => setLang(e.target.value as "ru" | "uz")}
          >
            <option value="ru">Русский</option>
            <option value="uz">O‘zbekcha</option>
          </select>
        </label>
        <label className="text-sm space-y-1">
          Услуга для проверки
          <select
            className={style}
            value={service?.id ?? ""}
            onChange={(e) => setServiceId(e.target.value)}
          >
            {!service && <option value="">Добавьте услугу</option>}
            {config.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name[lang] || "Без названия"} · {s.durationMin} мин
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm space-y-1">
          Ресурс для проверки
          <select
            className={style}
            value={resource?.id ?? ""}
            onChange={(e) => setResourceId(e.target.value)}
          >
            {!resource && <option value="">Добавьте ресурс</option>}
            {config.resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name[lang] || "Без названия"}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm space-y-1">
          День для проверки
          <select className={style} value={day} onChange={(e) => setDay(Number(e.target.value))}>
            {["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"].map((name, index) => (
              <option key={index} value={index}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {service && (
        <p className="text-sm text-ui-secondary">
          {service.name[lang] || "Без названия"} · {service.durationMin} мин ·{" "}
          {service.priceUzs.toLocaleString("ru-RU")} UZS
        </p>
      )}
      {slots.length ? (
        <div className="flex flex-wrap gap-2">
          {slots.slice(0, 12).map((time) => (
            <span
              key={time}
              className="rounded-lg bg-ui-surface border border-ui-border px-3 py-2 text-sm"
            >
              {time}
            </span>
          ))}
          {slots.length > 12 && (
            <span className="px-3 py-2 text-sm text-ui-muted">Ещё {slots.length - 12}</span>
          )}
        </div>
      ) : (
        <p className="text-sm text-ui-warning">
          Нет времени для записи. Проверьте рабочий день, назначение услуги, длительность и перерыв.
        </p>
      )}
    </section>
  );
}
