import { EditorToolbar } from "./EditorToolbar.js";
import { EditorReadiness } from "./EditorReadiness.js";
import { quizSetupIssues, createQuizChain } from "@lcqb/contracts/validation";
import { useEditorChanges } from "../../hooks/useEditorChanges.js";
import { ApiErrorAlert } from "../common/ApiErrorAlert.js";
import { QuizDraftConfigSchema, createEmptyQuizConfig } from "@lcqb/contracts";
import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { QuizConfig, QuizNode } from "@lcqb/contracts";
import type { BotDetails } from "../../api/bots.js";
import { updateBotSettings } from "../../api/templates.js";
import { Button } from "../common/Button.js";
import { Alert } from "../common/Alert.js";
import { Textarea } from "../common/Input.js";
import { QuestionCard } from "./quiz/QuestionCard.js";
import { QuizFlowPreview } from "./quiz/QuizFlowPreview.js";

interface BotQuizEditorTabProps {
  bot: BotDetails;
}

export function BotQuizEditorTab({ bot }: BotQuizEditorTabProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"visual" | "json">("visual");

  const [config, setConfig] = useState<QuizConfig>(() => {
    const settings = bot.settings as { quiz?: unknown } | null;
    const result = QuizDraftConfigSchema.safeParse(settings?.quiz ?? settings);
    return result.success ? result.data : createEmptyQuizConfig();
  });

  const [jsonText, setJsonText] = useState(() => JSON.stringify(config, null, 2));
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string[]>([]);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { dirty, markSaved } = useEditorChanges(`bot:${bot.id}`, config, jsonText, mode);

  const saveMut = useMutation({
    mutationFn: (newSettings: unknown) => updateBotSettings(bot.id, newSettings),
    onSuccess: (_saved, submitted) => {
      markSaved(submitted);
      void queryClient.invalidateQueries({ queryKey: ["bot", bot.id] });
      setSuccessMsg("Опросник успешно сохранён.");
      setErrorMsg(null);
      setErrorDetails([]);
    },
    onError: () => {
      setErrorMsg(null);
      setErrorDetails([]);
      setSuccessMsg(null);
    },
  });

  const handleModeChange = (newMode: "visual" | "json") => {
    if (newMode === mode) return;
    if (newMode === "json") {
      setJsonText(JSON.stringify(config, null, 2));
    } else {
      try {
        const result = QuizDraftConfigSchema.safeParse(JSON.parse(jsonText));
        if (!result.success) {
          setErrorMsg(
            "Структура JSON не соответствует настройкам бота. Исправьте поля перед переключением.",
          );
          return;
        }
        setConfig(result.data);
        setErrorMsg(null);
      } catch {
        setErrorMsg("Не удалось переключиться: некорректный JSON");
        return;
      }
    }
    setMode(newMode);
  };

  const handleSave = () => {
    setErrorMsg(null);
    setErrorDetails([]);
    if (mode === "json") {
      try {
        const parsed = JSON.parse(jsonText);
        const issues = quizSetupIssues(parsed);
        if (issues.length) {
          setErrorMsg(issues.join(" "));
          return;
        }
        saveMut.mutate(parsed);
      } catch {
        setErrorMsg("Ошибка синтаксиса JSON. Проверьте правильность скобок и кавычек.");
      }
    } else {
      const issues = quizSetupIssues(config);
      if (issues.length) {
        setErrorMsg(issues.join(" "));
        return;
      }
      saveMut.mutate(config);
    }
  };

  const handleUpdateNode = (index: number, updated: QuizNode) => {
    const newNodes = [...config.nodes];
    newNodes[index] = updated;
    const newConfig = { ...config, nodes: newNodes };
    setConfig(newConfig);
    setJsonText(JSON.stringify(newConfig, null, 2));
  };

  const handleDeleteNode = (index: number) => {
    const nodeToDelete = config.nodes[index];
    if (!nodeToDelete) return;
    if (
      !window.confirm(
        `Удалить вопрос «${nodeToDelete.title.ru}»? Ответы, ведущие на него, будут завершать опрос. Проверьте длину всех путей перед сохранением.`,
      )
    )
      return;
    const removedId = nodeToDelete.id;
    const newNodes = config.nodes.filter((_, i) => i !== index);
    const newStart =
      config.startNodeId === removedId ? (newNodes[0]?.id ?? "") : config.startNodeId;
    const sanitizedNodes = newNodes.map((n) => ({
      ...n,
      options: n.options.map((opt) =>
        opt.nextNodeId === removedId ? { ...opt, nextNodeId: null } : opt,
      ),
    }));
    const newConfig = { ...config, startNodeId: newStart, nodes: sanitizedNodes };
    setConfig(newConfig);
    setJsonText(JSON.stringify(newConfig, null, 2));
  };

  const handleMoveNode = (fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= config.nodes.length) return;
    const newNodes = [...config.nodes];
    const [moved] = newNodes.splice(fromIdx, 1);
    if (!moved) return;
    newNodes.splice(toIdx, 0, moved);
    const newConfig = { ...config, nodes: newNodes };
    setConfig(newConfig);
    setJsonText(JSON.stringify(newConfig, null, 2));
  };

  const handleAddQuestion = () => {
    const nextNum = config.nodes.length + 1;
    const newId = crypto.randomUUID();
    const newNode: QuizNode = {
      id: newId,
      title: { ru: `Новый вопрос ${nextNum}`, uz: `Yangi savol ${nextNum}` },
      options: [
        {
          id: crypto.randomUUID(),
          text: { ru: "Вариант ответа", uz: "Javob varianti" },
          nextNodeId: null,
        },
      ],
    };
    const newConfig = {
      ...config,
      startNodeId: config.startNodeId || newId,
      nodes: [...config.nodes, newNode],
    };
    setConfig(newConfig);
    setJsonText(JSON.stringify(newConfig, null, 2));
  };

  return (
    <div className="space-y-6">
      <EditorToolbar
        title="Вопросы для сбора заявки"
        description="Заполните вопросы на двух языках. Клиент должен пройти 3–5 вопросов до передачи контакта."
        mode={mode}
        pending={saveMut.isPending}
        onModeChange={handleModeChange}
        onSave={handleSave}
      />
      {mode === "visual" && <EditorReadiness issues={quizSetupIssues(config)} />}

      {dirty && (
        <Alert type="warning" title="Есть несохранённые изменения">
          Черновик сохраняется при переключении вкладок. Нажмите «Сохранить», чтобы применить
          настройки.
        </Alert>
      )}
      <ApiErrorAlert error={saveMut.error} />
      {config.nodes.length === 0 && (
        <Alert type="info" title="Настройка с нуля">
          Добавьте первый вопрос или выберите готовый шаблон. До сохранения сценария бот не собирает
          заявки.
        </Alert>
      )}
      {successMsg && !dirty && (
        <Alert type="success" title="Успешно">
          {successMsg}
        </Alert>
      )}

      {errorMsg && (
        <Alert type="error" title="Ошибка валидации квиза">
          <p>{errorMsg}</p>
          {errorDetails.length > 0 && (
            <ul className="list-disc list-inside mt-2 space-y-1 text-sm">
              {errorDetails.map((det, idx) => (
                <li key={idx}>{det}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      <fieldset disabled={saveMut.isPending} className="min-w-0">
        {mode === "visual" ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            <div className="lg:col-span-2 space-y-4">
              {config.nodes.length === 0 && (
                <Button
                  variant="outline"
                  onClick={() => {
                    const next = createQuizChain();
                    setConfig(next);
                    setJsonText(JSON.stringify(next, null, 2));
                  }}
                >
                  Создать цепочку из 3 вопросов
                </Button>
              )}
              <p className="text-sm text-ui-muted">
                У каждого ответа выберите следующий вопрос или запрос контакта. Кнопки вверх и вниз
                меняют порядок карточек, а переходы остаются прежними.
              </p>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm font-semibold text-ui-secondary">
                  Список вопросов ({config.nodes.length}):
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleAddQuestion}
                  icon={<Plus className="h-3.5 w-3.5" />}
                >
                  Добавить вопрос
                </Button>
              </div>

              <div className="space-y-4">
                {config.nodes.map((node, idx) => (
                  <QuestionCard
                    key={node.id}
                    node={node}
                    index={idx}
                    totalNodes={config.nodes.length}
                    isStartNode={node.id === config.startNodeId}
                    allNodes={config.nodes}
                    onSetStart={() => {
                      const next = { ...config, startNodeId: node.id };
                      setConfig(next);
                      setJsonText(JSON.stringify(next, null, 2));
                    }}
                    onUpdate={(updated) => handleUpdateNode(idx, updated)}
                    onDelete={() => handleDeleteNode(idx)}
                    onMoveUp={() => handleMoveNode(idx, idx - 1)}
                    onMoveDown={() => handleMoveNode(idx, idx + 1)}
                  />
                ))}
              </div>
            </div>

            <div className="lg:sticky lg:top-6 space-y-4">
              <QuizFlowPreview
                key={JSON.stringify(config)}
                nodes={config.nodes}
                startNodeId={config.startNodeId}
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
