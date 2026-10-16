import type { QuickBookResource, QuickBookService, ResourceType } from "@lcqb/contracts";
import { resourceWording } from "../../../utils/resource-wording.js";
import { Input } from "../../common/Input.js";
import { Button } from "../../common/Button.js";
import { WeekDaysPicker } from "./WeekDaysPicker.js";
import { ResourceServices } from "./ResourceServices.js";
export function ResourceCard({
  resource,
  index,
  resourceType,
  services,
  onChange,
  onDelete,
  onCopy,
}: {
  resource: QuickBookResource;
  index: number;
  resourceType: ResourceType;
  services: QuickBookService[];
  onChange: (value: QuickBookResource) => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const wording = resourceWording[resourceType];
  const scope = `Ресурс ${index + 1}`;
  return (
    <section className="rounded-xl border border-ui-border bg-ui-subtle p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="font-medium">{resource.name.ru || `${wording.placeholder} ${index + 1}`}</h5>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onCopy}>
            Дублировать ресурс {index + 1}
          </Button>
          <Button variant="outline" size="sm" onClick={onDelete}>
            {wording.remove} {index + 1}
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          label={`${wording.placeholder} ${index + 1} (RU)`}
          placeholder={`${wording.placeholder} (RU)`}
          value={resource.name.ru}
          onChange={(e) =>
            onChange({ ...resource, name: { ...resource.name, ru: e.target.value } })
          }
        />
        <Input
          label={`${wording.placeholder} ${index + 1} (UZ)`}
          placeholder={`${wording.placeholder} (UZ)`}
          value={resource.name.uz}
          onChange={(e) =>
            onChange({ ...resource, name: { ...resource.name, uz: e.target.value } })
          }
        />
      </div>
      <div className="space-y-2">
        <p className="text-sm text-ui-secondary">Рабочие дни недели</p>
        <WeekDaysPicker
          selectedDays={resource.workDays}
          onChange={(days) => onChange({ ...resource, workDays: days })}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          label={`${scope}: начало работы`}
          type="time"
          value={resource.workHours.start}
          onChange={(e) =>
            onChange({ ...resource, workHours: { ...resource.workHours, start: e.target.value } })
          }
        />
        <Input
          label={`${scope}: окончание работы`}
          type="time"
          value={resource.workHours.end}
          onChange={(e) =>
            onChange({ ...resource, workHours: { ...resource.workHours, end: e.target.value } })
          }
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={Boolean(resource.breakHours)}
          onChange={(e) =>
            onChange({
              ...resource,
              breakHours: e.target.checked ? { start: "13:00", end: "14:00" } : undefined,
            })
          }
        />
        {scope}: добавить перерыв
      </label>
      {resource.breakHours && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label={`${scope}: начало перерыва`}
            type="time"
            value={resource.breakHours.start}
            onChange={(e) =>
              onChange({
                ...resource,
                breakHours: { ...resource.breakHours!, start: e.target.value },
              })
            }
          />
          <Input
            label={`${scope}: окончание перерыва`}
            type="time"
            value={resource.breakHours.end}
            onChange={(e) =>
              onChange({
                ...resource,
                breakHours: { ...resource.breakHours!, end: e.target.value },
              })
            }
          />
        </div>
      )}
      <ResourceServices resource={resource} services={services} onChange={onChange} />
    </section>
  );
}
