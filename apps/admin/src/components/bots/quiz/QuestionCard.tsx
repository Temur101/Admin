import React from "react";
import { ArrowUp, ArrowDown, Trash2, Plus, Flag } from "lucide-react";
import type { QuizNode, QuizOption } from "@lcqb/contracts";
import { OptionRow } from "./OptionRow.js";

interface QuestionCardProps {
  node: QuizNode;
  index: number;
  totalNodes: number;
  isStartNode: boolean;
  allNodes: QuizNode[];
  onSetStart: () => void;
  onUpdate: (updated: QuizNode) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isSelected?: boolean;
  onSelect?: () => void;
}

export function QuestionCard({
  node,
  index,
  totalNodes,
  isStartNode,
  allNodes,
  onSetStart,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
  isSelected,
  onSelect,
}: QuestionCardProps) {
  const handleOptionChange = (optIndex: number, updatedOption: QuizOption) => {
    const newOptions = [...node.options];
    newOptions[optIndex] = updatedOption;
    onUpdate({ ...node, options: newOptions });
  };

  const handleOptionDelete = (optIndex: number) => {
    if (node.options.length <= 1) return;
    const newOptions = node.options.filter((_, i) => i !== optIndex);
    onUpdate({ ...node, options: newOptions });
  };

  const handleAddOption = () => {
    const newOption: QuizOption = {
      id: `opt_${Date.now().toString(36)}_${node.options.length + 1}`,
      text: { ru: `Вариант ${node.options.length + 1}`, uz: `Variant ${node.options.length + 1}` },
      nextNodeId: null,
    };
    onUpdate({ ...node, options: [...node.options, newOption] });
  };

  return (
    <div
      onClick={onSelect}
      className={`p-4 bg-slate-900 border rounded-2xl space-y-3 transition-colors ${
        isSelected
          ? "border-indigo-500/80 ring-1 ring-indigo-500/30"
          : isStartNode
            ? "border-emerald-500/40"
            : "border-slate-800"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-indigo-400">
            Вопрос #{index + 1}
          </span>
          <span className="font-mono text-[10px] px-2 py-0.5 bg-slate-950 border border-slate-800 rounded-md text-slate-400">
            {node.id}
          </span>
          {isStartNode ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 text-[10px] border border-emerald-500/30 font-medium">
              <Flag className="h-3 w-3" />
              Старт
            </span>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSetStart();
              }}
              className="px-2 py-0.5 text-[10px] text-slate-400 hover:text-emerald-300 hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
            >
              Сделать стартом
            </button>
          )}
        </div>

        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={onMoveUp}
            disabled={index === 0}
            title="Переместить вверх"
            className="p-1 rounded-md text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-800 cursor-pointer"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index === totalNodes - 1}
            title="Переместить вниз"
            className="p-1 rounded-md text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-800 cursor-pointer"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={totalNodes <= 1}
            title={totalNodes <= 1 ? "Нельзя удалить единственный вопрос" : "Удалить вопрос"}
            className="p-1 rounded-md text-slate-400 hover:text-rose-400 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-800 cursor-pointer ml-1"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div>
          <label className="block text-[11px] font-medium text-slate-400 mb-1">
            Заголовок вопроса (RU)
          </label>
          <input
            type="text"
            value={node.title.ru}
            onChange={(e) =>
              onUpdate({
                ...node,
                title: { ...node.title, ru: e.target.value },
              })
            }
            placeholder="Какая услуга вас интересует?"
            className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-slate-400 mb-1">
            Заголовок вопроса (UZ)
          </label>
          <input
            type="text"
            value={node.title.uz}
            onChange={(e) =>
              onUpdate({
                ...node,
                title: { ...node.title, uz: e.target.value },
              })
            }
            placeholder="Sizni qaysi xizmat qiziqtiradi?"
            className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
          />
        </div>
      </div>

      <div className="space-y-2 pt-1">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-medium text-slate-400">
            Варианты ответов ({node.options.length}):
          </label>
          <button
            type="button"
            onClick={handleAddOption}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300 cursor-pointer"
          >
            <Plus className="h-3 w-3" />
            Добавить вариант
          </button>
        </div>

        <div className="space-y-2">
          {node.options.map((opt, optIdx) => (
            <OptionRow
              key={opt.id}
              option={opt}
              nodes={allNodes}
              currentNodeId={node.id}
              onChange={(updated) => handleOptionChange(optIdx, updated)}
              onDelete={() => handleOptionDelete(optIdx)}
              canDelete={node.options.length > 1}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
