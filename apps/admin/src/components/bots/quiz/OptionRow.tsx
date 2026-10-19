import { QUIZ_FREE_TEXT_MAX_LENGTH, type QuizOption, type QuizNode } from "@lcqb/contracts";
import { Input } from "../../common/Input.js";
import { Button } from "../../common/Button.js";
interface OptionRowProps {
  option: QuizOption;
  nodes: QuizNode[];
  currentNodeId: string;
  index: number;
  onChange: (value: QuizOption) => void;
  onDelete: () => void;
  canDelete: boolean;
}
export function OptionRow({
  option,
  nodes,
  currentNodeId,
  index,
  onChange,
  onDelete,
  canDelete,
}: OptionRowProps) {
  const question = nodes.findIndex((n) => n.id === currentNodeId) + 1;
  const label = `Вопрос ${question}, ответ ${index + 1}`;
  return (
    <div className="p-3 rounded-xl border border-ui-border bg-ui-subtle space-y-3">
      <label className="block space-y-1 text-sm text-ui-secondary">
        Тип ответа
        <select
          aria-label={`${label}: тип ответа`}
          value={option.inputType ?? "CHOICE"}
          onChange={(e) => onChange({ ...option, inputType: e.target.value as "CHOICE" | "TEXT" })}
          className="w-full min-h-11 rounded-xl border border-ui-border bg-ui-surface px-3"
        >
          <option value="CHOICE">Выбор кнопкой</option>
          <option value="TEXT">Свой ответ — ввод текста</option>
        </select>
      </label>
      {option.inputType === "TEXT" && (
        <p className="text-sm text-ui-muted">
          Тексты ниже — название кнопки. После нажатия клиент напишет ответ или вопрос одним
          сообщением до {QUIZ_FREE_TEXT_MAX_LENGTH} символов. Затем бот перейдёт к выбранному шагу.
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          label={`${label} (RU)`}
          placeholder="Текст ответа (RU)"
          value={option.text.ru}
          onChange={(e) => onChange({ ...option, text: { ...option.text, ru: e.target.value } })}
        />
        <Input
          label={`${label} (UZ)`}
          placeholder="Текст ответа (UZ)"
          value={option.text.uz}
          onChange={(e) => onChange({ ...option, text: { ...option.text, uz: e.target.value } })}
        />
      </div>
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <label className="flex-1 min-w-0 space-y-1 text-sm text-ui-secondary">
          После этого ответа
          <select
            aria-label={`${label}: следующий шаг`}
            value={option.nextNodeId ?? ""}
            onChange={(e) => onChange({ ...option, nextNodeId: e.target.value || null })}
            className="w-full min-w-0 min-h-11 rounded-xl border border-ui-border bg-ui-surface px-3"
          >
            <option value="">Завершить опрос и запросить контакт</option>
            {option.nextNodeId && !nodes.some((n) => n.id === option.nextNodeId) && (
              <option value={option.nextNodeId}>Удалённый вопрос — выберите другой</option>
            )}
            {nodes.map(
              (node, i) =>
                node.id !== currentNodeId && (
                  <option key={node.id} value={node.id}>
                    Вопрос {i + 1}: {node.title.ru || "Без названия"}
                  </option>
                ),
            )}
          </select>
        </label>
        <Button variant="outline" size="sm" disabled={!canDelete} onClick={onDelete}>
          Удалить ответ {index + 1}
        </Button>
      </div>
    </div>
  );
}
