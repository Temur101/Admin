import type { TenantItem } from "../../../api/tenants.js";
import type { CreationDraft } from "../../../utils/onboarding-draft.js";
import { Input } from "../../common/Input.js";
import { Button } from "../../common/Button.js";

export function ClientStep({
  draft,
  tenants,
  update,
}: {
  draft: CreationDraft;
  tenants: TenantItem[];
  update: (partial: Partial<CreationDraft>) => void;
}) {
  return (
    <div className="space-y-4">
      <h4 className="text-lg font-semibold text-ui-text">Для какого клиента подключаем бота?</h4>
      <div className="flex flex-wrap gap-2">
        <Button
          variant={draft.clientMode === "existing" ? "primary" : "outline"}
          onClick={() => update({ clientMode: "existing" })}
        >
          Выбрать клиента
        </Button>
        <Button
          variant={draft.clientMode === "new" ? "primary" : "outline"}
          onClick={() => update({ clientMode: "new", tenantId: "" })}
        >
          Создать клиента
        </Button>
      </div>
      {draft.clientMode === "existing" ? (
        <div className="space-y-2">
          <label htmlFor="setup-client" className="text-sm font-medium text-ui-secondary">
            Клиент
          </label>
          <select
            id="setup-client"
            value={draft.tenantId}
            onChange={(event) => update({ tenantId: event.target.value })}
            className="w-full min-h-11 rounded-xl border border-ui-border bg-ui-surface px-3 text-ui-text"
          >
            <option value="">Выберите клиента</option>
            {tenants
              .filter((tenant) => tenant.status !== "SUSPENDED" && !tenant.isSuspended)
              .map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.clientName} ({tenant.contactPhone})
                </option>
              ))}
          </select>
          {tenants.length === 0 && (
            <p className="text-sm text-ui-muted">
              Клиентов пока нет. Создайте первого прямо здесь.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <Input
            label="Имя клиента или компания"
            value={draft.clientName}
            onChange={(event) => update({ clientName: event.target.value })}
          />
          <Input
            label="Телефон клиента"
            type="tel"
            value={draft.contactPhone}
            onChange={(event) => update({ contactPhone: event.target.value })}
            placeholder="+998 90 123 45 67"
          />
        </div>
      )}
    </div>
  );
}
