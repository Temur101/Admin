import type { QuickBookResource, QuickBookService } from "@lcqb/contracts";
export function ResourceServices({
  resource,
  services,
  onChange,
}: {
  resource: QuickBookResource;
  services: QuickBookService[];
  onChange: (value: QuickBookResource) => void;
}) {
  const all = !resource.serviceIds?.length;
  const assigned = all ? services.map((s) => s.id) : resource.serviceIds!;
  return (
    <div className="space-y-3 border-t border-ui-border pt-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={all}
          disabled={!services.length}
          onChange={(e) =>
            onChange({ ...resource, serviceIds: e.target.checked ? undefined : [services[0]!.id] })
          }
        />
        Все услуги, включая добавленные позже
      </label>
      {!all && (
        <>
          <p className="text-sm text-ui-muted">Выберите хотя бы одну услугу для этого ресурса.</p>
          <div className="flex flex-wrap gap-2">
            {services.map((service) => {
              const selected = assigned.includes(service.id);
              return (
                <button
                  key={service.id}
                  type="button"
                  aria-pressed={selected}
                  disabled={selected && assigned.length === 1}
                  onClick={() =>
                    onChange({
                      ...resource,
                      serviceIds: selected
                        ? assigned.filter((id) => id !== service.id)
                        : [...assigned, service.id],
                    })
                  }
                  className={`rounded-lg border px-3 py-2 text-sm disabled:cursor-not-allowed ${selected ? "bg-ui-accent-soft border-ui-accent-border text-ui-accent" : "bg-ui-surface border-ui-border text-ui-muted"}`}
                >
                  {selected ? "✓ " : "+ "}
                  {service.name.ru || "Без названия"}
                </button>
              );
            })}
          </div>
        </>
      )}
      {!services.length && <p className="text-sm text-ui-muted">Сначала добавьте услугу.</p>}
    </div>
  );
}
