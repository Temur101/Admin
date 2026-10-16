import React from "react";
import { ArrowUp, ArrowDown, Trash2, Plus, Flag } from "lucide-react";
import type { QuizNode, QuizOption } from "@lcqb/contracts";
import { Input } from "../../common/Input.js";
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
      id: crypto.randomUUID(),
      text: { ru: `Вариант ${node.options.length + 1}`, uz: `Variant ${node.options.length + 1}` },
      nextNodeId: null,
    };
    onUpdate({ ...node, options: [...node.options, newOption] });
  };

  return (
    <div
      onClick={onSelect}
      className={`p-4 bg-ui-surface border rounded-2xl space-y-3 transition-colors ${
        isSelected
          ? "border-ui-accent-border ring-1 ring-ui-accent"
          : isStartNode
            ? "border-ui-success-border"
            : "border-ui-border"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-ui-accent">Вопрос #{index + 1}</span>
          {isStartNode ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-ui-success-soft text-ui-success text-xs border border-ui-success-border font-medium">
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
              className="px-2 py-0.5 text-xs text-ui-muted hover:text-ui-success hover:bg-ui-hover rounded-md transition-colors cursor-pointer"
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
            className="p-1 rounded-md text-ui-muted hover:text-ui-text disabled:opacity-30 disabled:cursor-not-allowed hover:bg-ui-hover cursor-pointer"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index === totalNodes - 1}
            title="Переместить вниз"
            className="p-1 rounded-md text-ui-muted hover:text-ui-text disabled:opacity-30 disabled:cursor-not-allowed hover:bg-ui-hover cursor-pointer"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="Удалить вопрос"
            aria-label={`Удалить вопрос ${index + 1}`}
            className="p-1 rounded-md text-ui-muted hover:text-ui-danger disabled:opacity-30 disabled:cursor-not-allowed hover:bg-ui-hover cursor-pointer ml-1"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          label={`Вопрос ${index + 1}: заголовок (RU)`}
          value={node.title.ru}
          onChange={(e) => onUpdate({ ...node, title: { ...node.title, ru: e.target.value } })}
        />
        <Input
          label={`Вопрос ${index + 1}: заголовок (UZ)`}
          value={node.title.uz}
          onChange={(e) => onUpdate({ ...node, title: { ...node.title, uz: e.target.value } })}
        />
      </div>

      <div className="space-y-2 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="text-sm font-medium text-ui-muted">
            Варианты ответов ({node.options.length}):
          </label>
          <button
            type="button"
            onClick={handleAddOption}
            className="inline-flex items-center gap-1 text-sm font-medium text-ui-accent hover:text-ui-accent-hover cursor-pointer"
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
              index={optIdx}
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
