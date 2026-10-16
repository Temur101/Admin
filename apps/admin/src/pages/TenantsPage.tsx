import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Phone, Bot, Trash2 } from "lucide-react";
import { getTenants, createTenant, suspendTenant, type TenantItem } from "../api/tenants.js";
import { Button } from "../components/common/Button.js";
import { Modal } from "../components/common/Modal.js";
import { Input } from "../components/common/Input.js";
import { Badge } from "../components/common/Badge.js";
import { Alert } from "../components/common/Alert.js";

export function TenantsPage() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [clientName, setClientName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const {
    data: tenants = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["tenants"],
    queryFn: getTenants,
  });

  const createMutation = useMutation({
    mutationFn: createTenant,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tenants"] });
      setIsCreateOpen(false);
      setClientName("");
      setContactPhone("");
      setFormError(null);
    },
    onError: (err: Error) => {
      setFormError(err.message || "Не удалось создать клиента");
    },
  });

  const suspendMutation = useMutation({
    mutationFn: suspendTenant,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tenants"] });
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientName.trim() || !contactPhone.trim()) {
      setFormError("Заполните имя и контактный телефон");
      return;
    }
    createMutation.mutate({ clientName: clientName.trim(), contactPhone: contactPhone.trim() });
  };

  const handleSuspend = (tenant: TenantItem) => {
    if (confirm(`Приостановить обслуживание клиента "${tenant.clientName}"?`)) {
      suspendMutation.mutate(tenant.id);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ui-text tracking-tight">Клиенты платформы</h1>
          <p className="text-sm text-ui-muted mt-1">Клиенты, владельцы ботов и их подписки</p>
        </div>
        <Button
          onClick={() => setIsCreateOpen(true)}
          variant="primary"
          icon={<Plus className="h-4 w-4" />}
        >
          Новый клиент
        </Button>
      </div>

      {error && (
        <Alert type="error" title="Ошибка загрузки">
          Не удалось получить список клиентов.
        </Alert>
      )}

      <div className="bg-ui-surface border border-ui-border rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-ui-subtle text-ui-muted border-b border-ui-border font-medium">
              <tr>
                <th className="px-5 py-3">Имя клиента / Компания</th>
                <th className="px-5 py-3">Телефон</th>
                <th className="px-5 py-3">Боты</th>
                <th className="px-5 py-3">Статус</th>
                <th className="px-5 py-3">Дата создания</th>
                <th className="px-5 py-3 text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ui-border text-ui-secondary">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-ui-muted">
                    Загрузка списка клиентов...
                  </td>
                </tr>
              ) : tenants.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-ui-muted">
                    Клиентов пока нет. Нажмите «Новый клиент», чтобы зарегистрировать первого
                    клиента.
                  </td>
                </tr>
              ) : (
                tenants.map((t) => (
                  <tr key={t.id} className="hover:bg-ui-hover transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div className="h-8 w-8 rounded-lg bg-ui-accent-soft text-ui-accent flex items-center justify-center font-semibold">
                          {t.clientName.slice(0, 1).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-semibold text-ui-text">{t.clientName}</p>
                          <p className="text-xs text-ui-muted font-mono">{t.id.slice(0, 8)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-ui-secondary">
                      <div className="flex items-center gap-1.5">
                        <Phone className="h-3 w-3 text-ui-muted" />
                        <span>{t.contactPhone}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="inline-flex items-center gap-1 text-ui-secondary">
                        <Bot className="h-3.5 w-3.5 text-ui-accent" />
                        {t.botsCount}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      {t.status === "SUSPENDED" || t.isSuspended ? (
                        <Badge variant="danger">Приостановлен</Badge>
                      ) : (
                        <Badge variant="success">Активен</Badge>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-ui-muted">
                      {new Date(t.createdAt).toLocaleDateString("ru-RU")}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      {t.status !== "SUSPENDED" && !t.isSuspended && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleSuspend(t)}
                          className="text-ui-muted hover:text-ui-danger"
                          title="Приостановить"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Новый клиент"
        description="Регистрация нового бизнес-клиента в платформе"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          {formError && (
            <Alert type="error" title="Ошибка">
              {formError}
            </Alert>
          )}

          <Input
            label="Имя клиента / Название заведения"
            placeholder="Например: Барбершоп «TopCut»"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            required
          />

          <Input
            label="Контактный телефон владельца"
            placeholder="+998901234567"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            required
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" type="button" onClick={() => setIsCreateOpen(false)}>
              Отмена
            </Button>
            <Button variant="primary" type="submit" isLoading={createMutation.isPending}>
              Создать клиента
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
