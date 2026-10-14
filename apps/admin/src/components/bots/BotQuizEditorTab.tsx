import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, Plus, Code, LayoutDashboard } from "lucide-react";
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
    const raw = bot.settings as Partial<QuizConfig> | null;
    if (raw && Array.isArray(raw.nodes) && raw.nodes.length > 0 && raw.startNodeId) {
      return raw as QuizConfig;
    }
    return {
      startNodeId: "q1",
      nodes: [
        {
          id: "q1",
          title: { ru: "Какая услуга вас интересует?", uz: "Sizni qaysi xizmat qiziqtiradi?" },
          options: [
            { id: "opt_1", text: { ru: "Консультация", uz: "Maslahat" }, nextNodeId: "q2" },
          ],
        },
        {
          id: "q2",
          title: { ru: "Когда вам удобно?", uz: "Qachon qulay?" },
          options: [
            { id: "opt_2", text: { ru: "Сегодня", uz: "Bugun" }, nextNodeId: "q3" },
          ],
        },
        {
          id: "q3",
          title: { ru: "Укажите бюджет", uz: "Byudjetni ko'rsating" },
          options: [
            { id: "opt_3", text: { ru: "Стандарт", uz: "Standart" }, nextNodeId: null },
          ],
        },
      ],
    };
  });

  const [jsonText, setJsonText] = useState(() => JSON.stringify(config, null, 2));
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string[]>([]);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const saveMut = useMutation({
    mutationFn: (newSettings: unknown) => updateBotSettings(bot.id, newSettings),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["bot", bot.id] });
      setSuccessMsg("Конфигурация квиза успешно сохранена и прошла DAG-валидацию.");
      setErrorMsg(null);
      setErrorDetails([]);
    },
    onError: (err: unknown) => {
      const errObj = err as { message?: string; details?: string[] };
      setErrorMsg(errObj.message || "Ошибка валидации конфигурации");
      setErrorDetails(Array.isArray(errObj.details) ? errObj.details : []);
      setSuccessMsg(null);
    },
  });

  const handleModeChange = (newMode: "visual" | "json") => {
    if (newMode === "json") {
      setJsonText(JSON.stringify(config, null, 2));
    } else {
      try {
        const parsed = JSON.parse(jsonText) as QuizConfig;
        if (parsed.nodes && parsed.startNodeId) {
          setConfig(parsed);
          setErrorMsg(null);
        }
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
        saveMut.mutate(parsed);
      } catch {
        setErrorMsg("Ошибка синтаксиса JSON. Проверьте правильность скобок и кавычек.");
      }
    } else {
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
    if (config.nodes.length <= 1) return;
    const nodeToDelete = config.nodes[index];
    if (!nodeToDelete) return;
    const removedId = nodeToDelete.id;
    const newNodes = config.nodes.filter((_, i) => i !== index);
    const newStart = config.startNodeId === removedId ? (newNodes[0]?.id ?? "") : config.startNodeId;
    const sanitizedNodes = newNodes.map((n) => ({
      ...n,
      options: n.options.map((opt) => (opt.nextNodeId === removedId ? { ...opt, nextNodeId: null } : opt)),
    }));
    const newConfig = { startNodeId: newStart, nodes: sanitizedNodes };
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
    const newId = `q${nextNum}_${Date.now().toString(36).slice(-4)}`;
    const newNode: QuizNode = {
      id: newId,
      title: { ru: `Новый вопрос ${nextNum}`, uz: `Yangi savol ${nextNum}` },
      options: [
        { id: `opt_${Date.now().toString(36)}`, text: { ru: "Вариант ответа", uz: "Javob varianti" }, nextNodeId: null },
      ],
    };
    const newConfig = { ...config, nodes: [...config.nodes, newNode] };
    setConfig(newConfig);
    setJsonText(JSON.stringify(newConfig, null, 2));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Конструктор квиза LeadCatch</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Настройка опросника (3–5 шагов), вариантов ответов и переходов (DAG-валидация)
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl bg-slate-900 border border-slate-800 p-1 text-xs">
            <button
              type="button"
              onClick={() => handleModeChange("visual")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                mode === "visual" ? "bg-indigo-600 text-white font-medium" : "text-slate-400 hover:text-white"
              }`}
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              Визуальный
            </button>
            <button
              type="button"
              onClick={() => handleModeChange("json")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                mode === "json" ? "bg-indigo-600 text-white font-medium" : "text-slate-400 hover:text-white"
              }`}
            >
              <Code className="h-3.5 w-3.5" />
              JSON
            </button>
          </div>

          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            isLoading={saveMut.isPending}
            icon={<Save className="h-4 w-4" />}
          >
            Сохранить
          </Button>
        </div>
      </div>

      {successMsg && (
        <Alert type="success" title="Успешно">
          {successMsg}
        </Alert>
      )}

      {errorMsg && (
        <Alert type="error" title="Ошибка валидации квиза">
          <p>{errorMsg}</p>
          {errorDetails.length > 0 && (
            <ul className="list-disc list-inside mt-2 space-y-1 text-xs">
              {errorDetails.map((det, idx) => (
                <li key={idx}>{det}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      {mode === "visual" ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300">
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
            <QuizFlowPreview nodes={config.nodes} startNodeId={config.startNodeId} />
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="block text-xs font-semibold text-slate-300">
            Прямое редактирование JSON:
          </label>
          <Textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            className="font-mono text-xs min-h-[400px]"
          />
        </div>
      )}
    </div>
  );
}
