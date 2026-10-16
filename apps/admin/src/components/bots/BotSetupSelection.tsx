import { useQuery } from "@tanstack/react-query";
import type { BotType, ResourceType } from "@lcqb/contracts";
import { getTemplates } from "../../api/templates.js";
import { ApiErrorAlert } from "../common/ApiErrorAlert.js";

interface BotSetupSelectionProps {
  botType: BotType;
  templateId: string;
  resourceType: ResourceType;
  onTemplateChange: (id: string) => void;
  onResourceChange: (type: ResourceType) => void;
}

export function BotSetupSelection({
  botType,
  templateId,
  resourceType,
  onTemplateChange,
  onResourceChange,
}: BotSetupSelectionProps) {
  const {
    data: templates = [],
    isPending,
    error,
  } = useQuery({ queryKey: ["templates"], queryFn: getTemplates });
  const matching = templates.filter((template) => template.botType === botType);
  const selected = matching.find((template) => template.id === templateId);
  const styles =
    "w-full px-3.5 py-2 bg-ui-subtle border border-ui-border rounded-xl text-sm text-ui-text";
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="initial-template" className="block text-sm font-medium text-ui-secondary">
          Начальная настройка
        </label>
        <select
          id="initial-template"
          className={styles}
          value={templateId}
          onChange={(event) => onTemplateChange(event.target.value)}
        >
          <option value="">Настроить с нуля</option>
          {templateId && !selected && <option value={templateId}>Сохранённый шаблон</option>}
          {matching.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
        <p className="text-sm text-ui-muted">
          {selected?.description ??
            (templateId
              ? "Сохранённый выбор шаблона будет проверен при подключении бота."
              : "Бот создаётся без готовых услуг и вопросов. Добавьте их в редакторе после подключения.")}
        </p>
        {isPending && <p className="text-sm text-ui-muted">Загружаем готовые шаблоны…</p>}
        <ApiErrorAlert error={error} />
        {error && <p className="text-sm text-ui-muted">Можно продолжить настройку с нуля.</p>}
      </div>
      {botType === "QUICKBOOK" && !templateId && (
        <div className="space-y-1.5">
          <label
            htmlFor="initial-resource-type"
            className="block text-sm font-medium text-ui-secondary"
          >
            На что принимаете запись?
          </label>
          <select
            id="initial-resource-type"
            className={styles}
            value={resourceType}
            onChange={(event) => onResourceChange(event.target.value as ResourceType)}
          >
            <option value="STAFF">Сотрудники</option>
            <option value="TABLE">Столы</option>
            <option value="ROOM">Помещения</option>
          </select>
        </div>
      )}
    </div>
  );
}
