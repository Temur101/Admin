import React from "react";
import { Trash2 } from "lucide-react";
import type { QuizOption, QuizNode } from "@lcqb/contracts";

interface OptionRowProps {
  option: QuizOption;
  nodes: QuizNode[];
  currentNodeId: string;
  onChange: (updated: QuizOption) => void;
  onDelete: () => void;
  canDelete: boolean;
}

export function OptionRow({
  option,
  nodes,
  currentNodeId,
  onChange,
  onDelete,
  canDelete,
}: OptionRowProps) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 p-2.5 bg-slate-950/70 border border-slate-800 rounded-xl">
      <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input
          type="text"
          value={option.text.ru}
          onChange={(e) =>
            onChange({
              ...option,
              text: { ...option.text, ru: e.target.value },
            })
          }
          placeholder="Текст ответа (RU)"
          className="px-2.5 py-1.5 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
        />
        <input
          type="text"
          value={option.text.uz}
          onChange={(e) =>
            onChange({
              ...option,
              text: { ...option.text, uz: e.target.value },
            })
          }
          placeholder="Текст ответа (UZ)"
          className="px-2.5 py-1.5 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      <div className="flex items-center gap-2">
        <select
          value={option.nextNodeId ?? ""}
          onChange={(e) =>
            onChange({
              ...option,
              nextNodeId: e.target.value ? e.target.value : null,
            })
          }
          className="px-2.5 py-1.5 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-slate-200 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 min-w-[150px]"
        >
          <option value="">🏁 Завершить (Контакт)</option>
          {nodes
            .filter((n) => n.id !== currentNodeId)
            .map((n, idx) => (
              <option key={n.id} value={n.id}>
                → Шаг {idx + 1}: {n.title.ru || n.id}
              </option>
            ))}
        </select>

        <button
          type="button"
          onClick={onDelete}
          disabled={!canDelete}
          title={canDelete ? "Удалить вариант" : "Нужен хотя бы один вариант"}
          className={`p-1.5 rounded-lg border transition-colors ${
            canDelete
              ? "border-slate-800 text-slate-400 hover:text-rose-400 hover:border-rose-900/50 cursor-pointer"
              : "border-slate-800 text-slate-600 cursor-not-allowed opacity-50"
          }`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
