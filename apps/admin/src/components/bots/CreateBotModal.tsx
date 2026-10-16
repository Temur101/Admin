import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CreateTenantRequestSchema } from "@lcqb/contracts";
import { createBot } from "../../api/bots.js";
import { createTenant, type TenantItem } from "../../api/tenants.js";
import { useAuthUserId } from "../../context/AuthContext.js";
import { useCreationDraft } from "../../hooks/useCreationDraft.js";
import { newCreationDraft } from "../../utils/onboarding-draft.js";
import { BotSetupSelection } from "./BotSetupSelection.js";
import { SetupSteps } from "./onboarding/SetupSteps.js";
import { ClientStep } from "./onboarding/ClientStep.js";
import { TaskStep } from "./onboarding/TaskStep.js";
import { ApiErrorAlert } from "../common/ApiErrorAlert.js";
import { Button } from "../common/Button.js";
import { Modal } from "../common/Modal.js";
import { Input } from "../common/Input.js";
import { Alert } from "../common/Alert.js";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  tenants: TenantItem[];
  draftScope?: string;
}
export function CreateBotModal({ isOpen, onClose, tenants, draftScope }: Props) {
  const actorId = useAuthUserId();
  return (
    <CreationWizard
      key={draftScope ?? actorId ?? "memory"}
      isOpen={isOpen}
      onClose={onClose}
      tenants={tenants}
      draftScope={draftScope ?? actorId}
    />
  );
}
function CreationWizard({ isOpen, onClose, tenants, draftScope }: Props) {
  const { draft, update, storageFailed } = useCreationDraft(draftScope);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [botToken, setBotToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [newTenant, setNewTenant] = useState<TenantItem | null>(null);
  const tenantMutation = useMutation({
    mutationFn: createTenant,
    onSuccess: (tenant) => {
      setNewTenant({ ...tenant, status: "ACTIVE", botsCount: 0 });
      update({ tenantId: tenant.id, clientMode: "existing", step: 1 });
      void queryClient.invalidateQueries({ queryKey: ["tenants"] });
    },
  });
  const botMutation = useMutation({
    mutationFn: createBot,
    onSuccess: (bot) => {
      update({ createdBotId: bot.id });
      setBotToken("");
      void queryClient.invalidateQueries({ queryKey: ["bots"] });
      void queryClient.invalidateQueries({ queryKey: ["tenants"] });
      onClose();
      navigate(`/bots/${bot.id}?setup=1`);
    },
  });
  const pending = tenantMutation.isPending || botMutation.isPending;
  const close = () => {
    if (!pending) {
      setBotToken("");
      setFormError(null);
      onClose();
    }
  };
  const next = () => {
    setFormError(null);
    if (draft.step === 0) {
      if (draft.clientMode === "new") {
        const parsed = CreateTenantRequestSchema.safeParse({
          clientName: draft.clientName.trim(),
          contactPhone: draft.contactPhone.trim(),
        });
        if (!parsed.success) {
          setFormError("Укажите имя клиента и корректный телефон (минимум 5 символов).");
          return;
        }
        tenantMutation.mutate(parsed.data);
      } else {
        const selected = [...tenants, ...(newTenant ? [newTenant] : [])].find(
          (tenant) => tenant.id === draft.tenantId,
        );
        if (!selected || selected.status === "SUSPENDED" || selected.isSuspended) {
          setFormError("Выберите действующего клиента или создайте нового.");
          return;
        }
        update({ step: 1 });
      }
    } else if (draft.step === 1) update({ step: 2 });
    else {
      if (botToken.trim().length < 10) {
        setFormError("Введите токен из @BotFather.");
        return;
      }
      botMutation.mutate({
        tenantId: draft.tenantId,
        botType: draft.botType,
        botToken: botToken.trim(),
        templateId: draft.templateId || undefined,
        resourceType:
          draft.botType === "QUICKBOOK" && !draft.templateId ? draft.resourceType : undefined,
        startPaused: true,
      });
    }
  };
  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title="Настройка нового бота"
      description="Пройдите шаги по порядку. Можно остановиться и продолжить позже."
      maxWidth="2xl"
    >
      {draft.createdBotId ? (
        <div className="space-y-4">
          <Alert type="info" title="Есть незавершённая настройка">
            Бот уже подключён. Продолжите его настройку без повторного создания.
          </Alert>
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => {
                close();
                navigate(`/bots/${draft.createdBotId}?setup=1`);
              }}
            >
              Продолжить настройку
            </Button>
            <Button variant="outline" onClick={() => update(newCreationDraft())}>
              Подключить другого бота
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <SetupSteps step={draft.step} />
          <ApiErrorAlert error={tenantMutation.error || botMutation.error} />
          {formError && (
            <Alert type="error" title="Проверьте поля">
              {formError}
            </Alert>
          )}
          {storageFailed && (
            <Alert type="warning" title="Черновик не сохранён">
              Браузер не разрешил сохранить прогресс. Не закрывайте страницу до завершения
              подключения.
            </Alert>
          )}
          <fieldset disabled={pending} className="space-y-5 min-w-0">
            {draft.step === 0 && (
              <ClientStep
                draft={draft}
                tenants={[
                  ...tenants,
                  ...(newTenant && !tenants.some((tenant) => tenant.id === newTenant.id)
                    ? [newTenant]
                    : []),
                ]}
                update={update}
              />
            )}
            {draft.step === 1 && (
              <TaskStep
                botType={draft.botType}
                onChange={(botType) => update({ botType, templateId: "" })}
              />
            )}
            {draft.step === 2 && (
              <div className="space-y-4">
                <h4 className="text-lg font-semibold text-ui-text">
                  Выберите шаблон и подключите Telegram-бота
                </h4>
                <BotSetupSelection
                  botType={draft.botType}
                  templateId={draft.templateId}
                  resourceType={draft.resourceType}
                  onTemplateChange={(templateId) => update({ templateId })}
                  onResourceChange={(resourceType) => update({ resourceType })}
                />
                <Input
                  label="Токен Telegram-бота (из @BotFather)"
                  type="password"
                  autoComplete="off"
                  value={botToken}
                  onChange={(event) => setBotToken(event.target.value)}
                  helperText="Токен не сохраняется в черновике. При возвращении на этот шаг введите его заново."
                />
                <p className="text-sm text-ui-muted">
                  Бот останется приостановленным до шага «Запуск».
                </p>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                variant="outline"
                onClick={
                  draft.step === 0
                    ? close
                    : () => {
                        setFormError(null);
                        update({ step: draft.step - 1 });
                      }
                }
              >
                {" "}
                {draft.step === 0 ? "Продолжить позже" : "Назад"}
              </Button>
              <Button onClick={next} isLoading={pending}>
                {draft.step === 2 ? "Подключить и настроить" : "Далее"}
              </Button>
            </div>
          </fieldset>
        </div>
      )}
    </Modal>
  );
}
