import { EditorToolbar } from "./EditorToolbar.js";
import { EditorReadiness } from "./EditorReadiness.js";
import { bookingSetupIssues } from "@lcqb/contracts/validation";
import { useEditorChanges } from "../../hooks/useEditorChanges.js";
import { ApiErrorAlert } from "../common/ApiErrorAlert.js";
import { QuickBookDraftConfigSchema, createEmptyQuickBookConfig } from "@lcqb/contracts";
import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QuickBookConfig } from "@lcqb/contracts";
import type { BotDetails } from "../../api/bots.js";
import { updateBotSettings } from "../../api/templates.js";
import { Alert } from "../common/Alert.js";
import { Textarea } from "../common/Input.js";
import { ServiceList } from "./schedule/ServiceList.js";
import { BookingPreview } from "./schedule/BookingPreview.js";
import { BookingParameters } from "./schedule/BookingParameters.js";
import { ResourceList } from "./schedule/ResourceList.js";

interface BotScheduleEditorTabProps {
  bot: BotDetails;
}

export function BotScheduleEditorTab({ bot }: BotScheduleEditorTabProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"visual" | "json">("visual");

  const [config, setConfig] = useState<QuickBookConfig>(() => {
    const settings = bot.settings as { quickbook?: unknown } | null;
    const result = QuickBookDraftConfigSchema.safeParse(settings?.quickbook ?? settings);
    return result.success ? result.data : createEmptyQuickBookConfig();
  });

  const [jsonText, setJsonText] = useState(() => JSON.stringify(config, null, 2));
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { dirty, markSaved } = useEditorChanges(`bot:${bot.id}`, config, jsonText, mode);

  const saveMut = useMutation({
    mutationFn: (newSettings: unknown) => updateBotSettings(bot.id, newSettings),
    onSuccess: (_saved, submitted) => {
      markSaved(submitted);
      void queryClient.invalidateQueries({ queryKey: ["bot", bot.id] });
      setSuccessMsg("Расписание и услуги QuickBook успешно сохранены.");
      setErrorMsg(null);
    },
    onError: () => {
      setErrorMsg(null);
      setSuccessMsg(null);
    },
  });

  const handleModeChange = (newMode: "visual" | "json") => {
    if (newMode === mode) return;
    if (newMode === "json") {
      setJsonText(JSON.stringify(config, null, 2));
    } else {
      try {
        const result = QuickBookDraftConfigSchema.safeParse(JSON.parse(jsonText));
        if (!result.success) {
          setErrorMsg(
            "Структура JSON не соответствует настройкам бота. Исправьте поля перед переключением.",
          );
          return;
        }
        setConfig(result.data);
        setErrorMsg(null);
      } catch {
        setErrorMsg("Не удалось переключиться: некорректный синтаксис JSON");
        return;
      }
    }
    setMode(newMode);
  };

  const handleSave = () => {
    setErrorMsg(null);
    if (mode === "json") {
      try {
        const parsed = JSON.parse(jsonText);
        const issues = bookingSetupIssues(parsed);
        if (issues.length) {
          setErrorMsg(issues.join(" "));
          return;
        }
        saveMut.mutate(parsed);
      } catch {
        setErrorMsg("Ошибка синтаксиса JSON. Проверьте правильность структуры.");
      }
    } else {
      const issues = bookingSetupIssues(config);
      if (issues.length) {
        setErrorMsg(issues.join(" "));
        return;
      }
      saveMut.mutate(config);
    }
  };

  const updateConfig = (partial: Partial<QuickBookConfig>) => {
    const updated = { ...config, ...partial };
    setConfig(updated);
    setJsonText(JSON.stringify(updated, null, 2));
  };

  return (
    <div className="space-y-6">
      <EditorToolbar
        title="Услуги и расписание"
        description="Укажите услуги, кто или что доступно для записи, рабочие часы и перерывы. Время — по Ташкенту."
        mode={mode}
        pending={saveMut.isPending}
        onModeChange={handleModeChange}
        onSave={handleSave}
      />
      {mode === "visual" && <EditorReadiness issues={bookingSetupIssues(config)} />}

      {dirty && (
        <Alert type="warning" title="Есть несохранённые изменения">
          Черновик сохраняется при переключении вкладок. Нажмите «Сохранить», чтобы применить
          настройки.
        </Alert>
      )}
      <ApiErrorAlert error={saveMut.error} />
      {(config.services.length === 0 || config.resources.length === 0) && (
        <Alert type="info" title="Настройка с нуля">
          Добавьте хотя бы одну услугу и один ресурс, затем сохраните настройки. До этого бот не
          принимает записи.
        </Alert>
      )}
      {successMsg && !dirty && (
        <Alert type="success" title="Успешно">
          {successMsg}
        </Alert>
      )}

      {errorMsg && (
        <Alert type="error" title="Ошибка">
          {errorMsg}
        </Alert>
      )}

      <fieldset disabled={saveMut.isPending} className="min-w-0">
        {mode === "visual" ? (
          <div className="space-y-6">
            <BookingParameters config={config} update={updateConfig} />
            <BookingPreview config={config} />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
              <ServiceList
                services={config.services}
                onChange={(services) =>
                  updateConfig({
                    services,
                    resources: config.resources.map((resource) => {
                      if (!resource.serviceIds?.length) return resource;
                      const ids = resource.serviceIds.filter((id) =>
                        services.some((service) => service.id === id),
                      );
                      return { ...resource, serviceIds: ids.length ? ids : undefined };
                    }),
                  })
                }
              />
              <ResourceList
                resourceType={config.resourceType}
                resources={config.resources}
                services={config.services}
                onChange={(resources) => updateConfig({ resources })}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="block text-sm font-semibold text-ui-secondary">
              Прямое редактирование JSON:
            </label>
            <Textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              className="font-mono text-sm min-h-[400px]"
            />
          </div>
        )}
      </fieldset>
    </div>
  );
}
