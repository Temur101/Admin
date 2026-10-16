const labels = ["Клиент", "Задача", "Шаблон", "Настройка", "Проверка", "Запуск"];
export function SetupSteps({ step }: { step: number }) {
  return (
    <ol
      aria-label="Этапы настройки"
      className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2"
    >
      {labels.map((label, index) => (
        <li
          key={label}
          aria-current={index === step ? "step" : undefined}
          className={`rounded-lg border px-3 py-2 text-sm ${index === step ? "bg-ui-accent-soft border-ui-accent text-ui-accent font-semibold" : "border-ui-border text-ui-muted bg-ui-subtle"}`}
        >
          <span aria-hidden="true">{index < step ? "✓" : index + 1} · </span>
          {label}
        </li>
      ))}
    </ol>
  );
}
