import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, ArrowRight } from "lucide-react";
import type { BotDetails } from "../../api/bots.js";
import { getTemplates, applyTemplate } from "../../api/templates.js";
import { Button } from "../common/Button.js";
import { Alert } from "../common/Alert.js";

interface BotTemplatesTabProps {
  bot: BotDetails;
}

export function BotTemplatesTab({ bot }: BotTemplatesTabProps) {
  const queryClient = useQueryClient();
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["templates"],
    queryFn: getTemplates,
  });

  const applyMut = useMutation({
    mutationFn: (templateId: string) => applyTemplate(bot.id, templateId),
    onSuccess: (_, templateId) => {
      void queryClient.invalidateQueries({ queryKey: ["bot", bot.id] });
      const tmpl = templates.find((t) => t.id === templateId);
      setSuccessMsg(`Шаблон "${tmpl?.name || templateId}" успешно применен к боту!`);
    },
  });

  const matchingTemplates = templates.filter((t) => t.botType === bot.botType);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-white">Каталог готовых пресетов</h3>
        <p className="text-xs text-slate-400 mt-1">
          Примените отраслевой шаблон в 1 клик для моментального запуска пилота
        </p>
      </div>

      {successMsg && (
        <Alert type="success" title="Шаблон применен">
          {successMsg}
        </Alert>
      )}

      {isLoading ? (
        <div className="p-8 text-center text-slate-500 text-xs">Загрузка каталога шаблонов...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {matchingTemplates.map((t) => (
            <div
              key={t.id}
              className="p-5 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col justify-between space-y-4 hover:border-slate-700 transition-colors"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                    <Sparkles className="h-4 w-4 text-indigo-400" />
                    {t.name}
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-slate-800 text-slate-400 border border-slate-700">
                    {t.id}
                  </span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">{t.description}</p>
              </div>

              <div className="pt-2 flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  isLoading={applyMut.isPending}
                  onClick={() => {
                    if (confirm(`Применить шаблон "${t.name}" к этому боту? Текущие настройки будут заменены.`)) {
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
            <div className="p-8 text-center text-slate-500 text-xs col-span-2">
              Для этого типа бота нет подходящих готовых шаблонов.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
