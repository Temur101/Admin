import type { BotType } from "@lcqb/contracts";
export function TaskStep({
  botType,
  onChange,
}: {
  botType: BotType;
  onChange: (type: BotType) => void;
}) {
  return (
    <div className="space-y-4">
      <h4 className="text-lg font-semibold text-ui-text">Что должен делать бот?</h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {(
          [
            {
              type: "LEADCATCH",
              title: "Собирать заявки",
              description: "Задаёт вопросы, собирает контакты и передаёт заявки владельцу.",
              name: "LeadCatch",
            },
            {
              type: "QUICKBOOK",
              title: "Принимать записи",
              description: "Предлагает услуги, сотрудника или ресурс и свободное время.",
              name: "QuickBook",
            },
          ] as const
        ).map((task) => (
          <button
            key={task.type}
            type="button"
            aria-pressed={botType === task.type}
            onClick={() => onChange(task.type)}
            className={`p-4 rounded-xl text-left border space-y-2 ${botType === task.type ? "bg-ui-accent-soft border-ui-accent" : "bg-ui-surface border-ui-border"}`}
          >
            <span className="block font-semibold text-ui-text">{task.title}</span>
            <span className="block text-sm text-ui-secondary">{task.description}</span>
            <span className="block text-xs text-ui-muted">{task.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
