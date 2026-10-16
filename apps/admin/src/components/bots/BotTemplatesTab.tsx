import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, ArrowRight } from "lucide-react";
import type { BotDetails } from "../../api/bots.js";
import { getTemplates, applyTemplate } from "../../api/templates.js";
import { Button } from "../common/Button.js";
import { ApiErrorAlert } from "../common/ApiErrorAlert.js";
import { Alert } from "../common/Alert.js";

interface BotTemplatesTabProps {
  bot: BotDetails;
  onApplied: () => void;
}

export function BotTemplatesTab({ bot, onApplied }: BotTemplatesTabProps) {
  const queryClient = useQueryClient();
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["templates"],
    queryFn: getTemplates,
  });

  const applyMut = useMutation({
    mutationFn: (templateId: string) => applyTemplate(bot.id, templateId),
    onSuccess: (settings, templateId) => {
      queryClient.setQueryData<BotDetails>(["bot", bot.id], (current) =>
        current ? { ...current, settings } : current,
      );
      onApplied();
      void queryClient.invalidateQueries({ queryKey: ["bot", bot.id] });
      const tmpl = templates.find((t) => t.id === templateId);
      setSuccessMsg(`Шаблон "${tmpl?.name || templateId}" успешно применен к боту!`);
    },
  });

  const matchingTemplates = templates.filter((t) => t.botType === bot.botType);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-ui-text">Каталог готовых пресетов</h3>
        <p className="text-sm text-ui-muted mt-1">
          Выберите подходящий шаблон, затем измените услуги, расписание или вопросы под своего
          клиента
        </p>
      </div>

      <ApiErrorAlert error={applyMut.error} />
      {successMsg && (
        <Alert type="success" title="Шаблон применен">
          {successMsg}
        </Alert>
      )}

      {isLoading ? (
        <div className="p-8 text-center text-ui-muted text-sm">Загрузка каталога шаблонов...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {matchingTemplates.map((t) => (
            <div
              key={t.id}
              className="p-5 bg-ui-surface border border-ui-border rounded-2xl flex flex-col justify-between space-y-4 hover:border-ui-border transition-colors"
            >
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-ui-text flex items-center gap-1.5">
                    <Sparkles className="h-4 w-4 text-ui-accent" />
                    {t.name}
                  </span>
                  <span className="text-xs font-mono px-2 py-0.5 rounded-md bg-ui-hover text-ui-muted border border-ui-border">
                    {t.id}
                  </span>
                </div>
                <p className="text-sm text-ui-muted leading-relaxed">{t.description}</p>
              </div>

              <div className="pt-2 flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  isLoading={applyMut.isPending}
                  onClick={() => {
                    if (
                      confirm(
                        `Применить шаблон "${t.name}" к этому боту? Текущие настройки и несохранённый черновик будут заменены.`,
                      )
                    ) {
                      applyMut.mutate(t.id);
                    }
                  }}
                  icon={<ArrowRight className="h-3.5 w-3.5" />}
                >
                  Применить этот шаблон
                </Button>
              </div>
            </div>
          ))}

          {matchingTemplates.length === 0 && (
            <div className="p-8 text-center text-ui-muted text-sm col-span-2">
              Для этого типа бота нет подходящих готовых шаблонов.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
