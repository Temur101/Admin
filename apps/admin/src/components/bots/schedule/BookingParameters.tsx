import type { QuickBookConfig, ResourceType } from "@lcqb/contracts";
import { RESOURCE_LABELS } from "@lcqb/contracts";
import { Input } from "../../common/Input.js";
export function BookingParameters({
  config,
  update,
}: {
  config: QuickBookConfig;
  update: (value: Partial<QuickBookConfig>) => void;
}) {
  return (
    <section className="rounded-2xl border border-ui-border bg-ui-surface p-4 space-y-4">
      <h4 className="font-semibold">Как принимать запись</h4>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <label className="space-y-2 text-sm text-ui-secondary">
          Тип ресурсов
          <select
            aria-label="Тип ресурсов"
            value={config.resourceType}
            onChange={(event) => {
              const type = event.target.value as ResourceType;
              update({ resourceType: type, resourceLabel: { ...RESOURCE_LABELS[type] } });
            }}
            className="w-full min-h-11 rounded-xl border border-ui-border bg-ui-surface px-3"
          >
            <option value="STAFF">Сотрудники</option>
            <option value="TABLE">Столы</option>
            <option value="ROOM">Помещения</option>
          </select>
        </label>
        <Input
          label="Интервал начала записей (мин)"
          type="number"
          min={5}
          max={120}
          value={config.slotIntervalMin}
          onChange={(e) => update({ slotIntervalMin: Number(e.target.value) })}
          helperText="При интервале 30 минут клиент увидит 09:00, 09:30, 10:00. Длительность услуги задаётся отдельно."
        />
        <Input
          label="Запись вперёд (дней)"
          type="number"
          min={1}
          max={60}
          value={config.bookingHorizonDays}
          onChange={(e) => update({ bookingHorizonDays: Number(e.target.value) })}
          helperText="От 1 до 60 календарных дней, включая сегодня, по времени Ташкента. Например, 1 — только сегодня."
        />
      </div>
      <details className="text-sm text-ui-secondary">
        <summary className="cursor-pointer">Название категории для клиента</summary>
        <p className="my-3 text-ui-muted">
          Например, «Врач» вместо «Сотрудник». Это название бот покажет при выборе ресурса.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Название категории (RU)"
            value={config.resourceLabel?.ru ?? RESOURCE_LABELS[config.resourceType].ru}
            onChange={(e) =>
              update({
                resourceLabel: {
                  ...(config.resourceLabel ?? RESOURCE_LABELS[config.resourceType]),
                  ru: e.target.value,
                },
              })
            }
          />
          <Input
            label="Название категории (UZ)"
            value={config.resourceLabel?.uz ?? RESOURCE_LABELS[config.resourceType].uz}
            onChange={(e) =>
              update({
                resourceLabel: {
                  ...(config.resourceLabel ?? RESOURCE_LABELS[config.resourceType]),
                  uz: e.target.value,
                },
              })
            }
          />
        </div>
      </details>
    </section>
  );
}
