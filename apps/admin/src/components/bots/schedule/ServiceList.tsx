import { Plus } from "lucide-react";
import type { QuickBookService } from "@lcqb/contracts";
import { Button } from "../../common/Button.js";
import { Input } from "../../common/Input.js";
interface ServiceListProps {
  services: QuickBookService[];
  onChange: (services: QuickBookService[]) => void;
}
export function ServiceList({ services, onChange }: ServiceListProps) {
  const update = (index: number, value: QuickBookService) =>
    onChange(services.map((service, i) => (i === index ? value : service)));
  return (
    <section className="rounded-2xl border border-ui-border bg-ui-surface p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="font-semibold">Список услуг ({services.length})</h4>
          <p className="text-sm text-ui-muted">Название, длительность и стоимость</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus className="h-4 w-4" />}
          onClick={() =>
            onChange([
              ...services,
              { id: crypto.randomUUID(), name: { ru: "", uz: "" }, durationMin: 30, priceUzs: 0 },
            ])
          }
        >
          Добавить услугу
        </Button>
      </div>
      {!services.length && (
        <p className="text-sm text-ui-muted">
          Услуг пока нет. Добавьте услугу, укажите название, длительность и стоимость.
        </p>
      )}
      {services.map((service, index) => (
        <section
          key={service.id}
          className="p-4 bg-ui-subtle border border-ui-border rounded-xl space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h5 className="font-medium">{service.name.ru || `Услуга ${index + 1}`}</h5>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  onChange([
                    ...services,
                    {
                      ...structuredClone(service),
                      id: crypto.randomUUID(),
                      name: { ru: `${service.name.ru} (копия)`, uz: `${service.name.uz} (nusxa)` },
                    },
                  ])
                }
              >
                Дублировать услугу {index + 1}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (
                    window.confirm(
                      `Удалить услугу «${service.name.ru || `Услуга ${index + 1}`}»? Она будет убрана из назначений ресурсов. Если у ресурса не останется выбранных услуг, он станет доступен для всех услуг. Существующие брони сохранятся.`,
                    )
                  )
                    onChange(services.filter((_, i) => i !== index));
                }}
              >
                Удалить услугу {index + 1}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label={`Услуга ${index + 1}: название (RU)`}
              placeholder="Название (RU)"
              value={service.name.ru}
              onChange={(e) =>
                update(index, { ...service, name: { ...service.name, ru: e.target.value } })
              }
            />
            <Input
              label={`Услуга ${index + 1}: название (UZ)`}
              placeholder="Название (UZ)"
              value={service.name.uz}
              onChange={(e) =>
                update(index, { ...service, name: { ...service.name, uz: e.target.value } })
              }
            />
            <Input
              label={`Услуга ${index + 1}: длительность (мин)`}
              type="number"
              min={5}
              max={480}
              value={service.durationMin}
              onChange={(e) => update(index, { ...service, durationMin: Number(e.target.value) })}
              helperText="Время, которое займёт услуга: от 5 до 480 минут."
            />
            <Input
              label={`Услуга ${index + 1}: цена (UZS)`}
              type="number"
              min={0}
              step={1}
              value={service.priceUzs}
              onChange={(e) => update(index, { ...service, priceUzs: Number(e.target.value) })}
              helperText="0 — бесплатно. Цена указывается целым числом."
            />
          </div>
        </section>
      ))}
    </section>
  );
}
