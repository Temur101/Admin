import { Plus } from "lucide-react";
import { resourceWording } from "../../../utils/resource-wording.js";
import type { QuickBookResource, QuickBookService, ResourceType } from "@lcqb/contracts";
import { Button } from "../../common/Button.js";
import { ResourceCard } from "./ResourceCard.js";
interface ResourceListProps {
  resourceType: ResourceType;
  resources: QuickBookResource[];
  services: QuickBookService[];
  onChange: (resources: QuickBookResource[]) => void;
}
export function ResourceList({ resourceType, resources, services, onChange }: ResourceListProps) {
  const wording = resourceWording[resourceType];
  return (
    <section className="p-4 bg-ui-surface border border-ui-border rounded-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="font-semibold">
            {wording.title} ({resources.length})
          </h4>
          <p className="text-sm text-ui-muted">Расписание, перерывы и доступные услуги</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus className="h-4 w-4" />}
          onClick={() =>
            onChange([
              ...resources,
              {
                id: crypto.randomUUID(),
                name: { ru: "", uz: "" },
                workDays: [1, 2, 3, 4, 5],
                workHours: { start: "09:00", end: "18:00" },
              },
            ])
          }
        >
          {wording.add}
        </Button>
      </div>
      {!resources.length && (
        <p className="text-sm text-ui-muted">
          Список пока пуст. Нажмите «{wording.add}», чтобы настроить расписание.
        </p>
      )}
      {resources.map((resource, index) => (
        <ResourceCard
          key={resource.id}
          resource={resource}
          index={index}
          resourceType={resourceType}
          services={services}
          onChange={(value) => onChange(resources.map((r, i) => (i === index ? value : r)))}
          onDelete={() => {
            if (
              window.confirm(
                `Удалить «${resource.name.ru || wording.placeholder}» из настройки? Существующие брони сохранятся, новые записи на этот ресурс станут недоступны.`,
              )
            )
              onChange(resources.filter((_, i) => i !== index));
          }}
          onCopy={() =>
            onChange([
              ...resources,
              {
                ...structuredClone(resource),
                id: crypto.randomUUID(),
                name: { ru: `${resource.name.ru} (копия)`, uz: `${resource.name.uz} (nusxa)` },
              },
            ])
          }
        />
      ))}
    </section>
  );
}
