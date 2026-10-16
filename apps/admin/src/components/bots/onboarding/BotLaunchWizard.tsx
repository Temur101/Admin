import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { checkBotSetup, launchBot, type BotDetails } from "../../../api/bots.js";
import { useAuthUserId } from "../../../context/AuthContext.js";
import { useHasUnsavedChanges } from "../../../context/UnsavedChangesContext.js";
import { formatPlatformDate } from "../../../utils/dates.js";
import {
  newCreationDraft,
  readCreationDraft,
  readSetupStep,
  saveCreationDraft,
  saveSetupStep,
  setupProgressKey,
} from "../../../utils/onboarding-draft.js";
import { Button } from "../../common/Button.js";
import { Alert } from "../../common/Alert.js";
import { ApiErrorAlert } from "../../common/ApiErrorAlert.js";
import { BotQuizEditorTab } from "../BotQuizEditorTab.js";
import { BotScheduleEditorTab } from "../BotScheduleEditorTab.js";
import { BotTemplatesTab } from "../BotTemplatesTab.js";
import { SetupSteps } from "./SetupSteps.js";
import { SetupCheckStep } from "./SetupCheckStep.js";
import { SetupFinish } from "./SetupFinish.js";

export function BotLaunchWizard({ bot, draftScope }: { bot: BotDetails; draftScope?: string }) {
  const actorId = useAuthUserId();
  const scope = draftScope ?? actorId;
  const [step, setStep] = useState(() => readSetupStep(scope, bot.id));
  const [editorRevision, setEditorRevision] = useState(0);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [launched, setLaunched] = useState(false);
  const dirty = useHasUnsavedChanges();
  const client = useQueryClient();
  const navigate = useNavigate();
  const goTo = (next: number) => {
    setStep(next);
    saveSetupStep(scope, bot.id, next);
  };
  const check = useQuery({
    queryKey: ["bot-setup-check", bot.id, bot.settings],
    queryFn: () => checkBotSetup(bot.id),
    enabled: step >= 4 && !dirty && !launched,
    retry: false,
    staleTime: 0,
  });
  const ready = check.isSuccess && !check.isFetching && Boolean(check.data?.canLaunch);
  const launch = useMutation({
    mutationFn: () => launchBot(bot.id),
    onSuccess: () => {
      client.setQueryData<BotDetails>(["bot", bot.id], (current) =>
        current ? { ...current, isActive: true } : current,
      );
      void client.invalidateQueries({ queryKey: ["bot", bot.id] });
      void client.invalidateQueries({ queryKey: ["bots"] });
      void client.invalidateQueries({ queryKey: ["bot-health", bot.id] });
      setLaunched(true);
    },
    onError: () => {
      void check.refetch();
    },
  });
  const finish = () => {
    if (scope) {
      if (readCreationDraft(scope).createdBotId === bot.id)
        saveCreationDraft(scope, newCreationDraft());
      try {
        localStorage.removeItem(setupProgressKey(scope, bot.id));
      } catch {
        /* Optional browser storage. */
      }
    }
    navigate(`/bots/${bot.id}`);
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ui-text">Мастер запуска бота</h1>
          <p className="text-sm text-ui-muted">
            {bot.tenantName} · {bot.botType === "LEADCATCH" ? "Сбор заявок" : "Онлайн-запись"}
          </p>
        </div>
        <Link to={`/bots/${bot.id}`} className="text-sm text-ui-accent">
          Продолжить позже
        </Link>
      </div>
      <SetupSteps step={step} />
      {bot.subscription?.status === "TRIAL" && (
        <p className="text-sm text-ui-muted">
          Пробный период начался при подключении бота и действует до (Ташкент):{" "}
          {formatPlatformDate(bot.subscription.trialEndsAt)}.
        </p>
      )}
      <div className="bg-ui-surface rounded-2xl border border-ui-border p-4 sm:p-6 space-y-5">
        <div hidden={step !== 3 || launched} className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Настройте сценарий клиента</h2>
            <Button variant="outline" onClick={() => setTemplatesOpen(!templatesOpen)}>
              {templatesOpen ? "Вернуться в редактор" : "Выбрать другой шаблон"}
            </Button>
          </div>
          {templatesOpen && (
            <BotTemplatesTab
              bot={bot}
              onApplied={() => {
                setEditorRevision((value) => value + 1);
                setTemplatesOpen(false);
              }}
            />
          )}
          <div hidden={templatesOpen}>
            {bot.botType === "LEADCATCH" ? (
              <BotQuizEditorTab key={editorRevision} bot={bot} />
            ) : (
              <BotScheduleEditorTab key={editorRevision} bot={bot} />
            )}
          </div>
        </div>
        {step === 4 && !launched && (
          <SetupCheckStep
            isActive={bot.isActive}
            check={check.data}
            error={check.error}
            pending={check.isFetching}
            refresh={() => void check.refetch()}
          />
        )}
        {step === 5 && !launched && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Запуск бота</h2>
            <p className="text-sm text-ui-secondary">
              После включения бот начнёт принимать сообщения клиентов. На сервере настройки и
              подключение проверяются повторно.
            </p>
            <ApiErrorAlert error={launch.error || check.error} />
            {!ready && !check.isFetching && (
              <Alert type="warning">
                Проверка не пройдена. Вернитесь на предыдущий шаг и исправьте замечания.
              </Alert>
            )}
            <Button
              disabled={dirty || !ready}
              isLoading={launch.isPending || check.isFetching}
              onClick={() => launch.mutate()}
            >
              {bot.isActive ? "Проверить готовность и продолжить" : "Запустить бота"}
            </Button>
          </div>
        )}
        {launched && <SetupFinish bot={{ ...bot, isActive: true }} onFinish={finish} />}
        {!launched && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ui-border pt-5">
            {step > 3 ? (
              <Button variant="outline" disabled={launch.isPending} onClick={() => goTo(step - 1)}>
                Назад
              </Button>
            ) : (
              <p className="text-sm text-ui-muted">
                Сохраните изменения в редакторе перед проверкой.
              </p>
            )}
            {step < 5 && (
              <Button disabled={dirty || (step === 4 && !ready)} onClick={() => goTo(step + 1)}>
                {step === 3 ? "Перейти к проверке" : "Перейти к запуску"}
              </Button>
            )}
          </div>
        )}
        {dirty && (
          <p className="text-sm text-ui-warning">Сначала сохраните изменения в редакторе.</p>
        )}
      </div>
    </div>
  );
}
