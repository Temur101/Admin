import { Alert } from "../common/Alert.js";
export function EditorReadiness({ issues }: { issues: string[] }) {
  return issues.length ? (
    <Alert type="info" title="Что осталось настроить">
      <ul className="list-disc pl-5 space-y-1">
        {issues.map((issue, index) => (
          <li key={index}>{issue}</li>
        ))}
      </ul>
      <p className="mt-2">Исправьте эти пункты перед сохранением и запуском.</p>
    </Alert>
  ) : (
    <p className="text-sm text-ui-success">
      Сценарий заполнен. Сохраните изменения и проверьте запуск в мастере.
    </p>
  );
}
