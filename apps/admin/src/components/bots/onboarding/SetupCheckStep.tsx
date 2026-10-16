import type { BotSetupCheck } from "../../../api/bots.js";
import { Button } from "../../common/Button.js";
import { Alert } from "../../common/Alert.js";
import { ApiErrorAlert } from "../../common/ApiErrorAlert.js";
export function SetupCheckStep({
  check,
  error,
  pending,
  refresh,
  isActive,
}: {
  check?: BotSetupCheck;
  error: unknown;
  pending: boolean;
  refresh: () => void;
  isActive: boolean;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-ui-text">Проверка перед запуском</h2>
      <p className="text-sm text-ui-secondary">
        Проверяем сохранённый сценарий, доступность Telegram и готовность сервера.
        {!isActive && " Бот пока остаётся приостановленным."}
      </p>
      <ApiErrorAlert error={error} />
      {pending && (
        <p role="status" className="text-sm text-ui-muted">
          Проверяем настройки и Telegram…
        </p>
      )}
      {check && !pending && !error && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-xl border border-ui-border p-4">
              <p className="font-medium">Сценарий</p>
              <p className={check.configurationReady ? "text-ui-success" : "text-ui-danger"}>
                {check.configurationReady
                  ? "Настройки сохранены и корректны"
                  : "Нужно исправить настройки"}
              </p>
            </div>
            <div className="rounded-xl border border-ui-border p-4">
              <p className="font-medium">Telegram</p>
              <p className={check.telegramReady ? "text-ui-success" : "text-ui-danger"}>
                {check.telegramReady
                  ? "Токен принят, Telegram доступен"
                  : "Подключение не проверено"}
              </p>
            </div>
          </div>
          {check.errors.length > 0 && (
            <Alert type="warning" title="Что осталось исправить">
              <ul className="list-disc pl-5 space-y-1">
                {check.errors.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </Alert>
          )}
          {check.canLaunch && (
            <Alert type="success" title="Можно запускать">
              После запуска откройте бота в Telegram и пройдите сценарий как клиент.
            </Alert>
          )}
        </>
      )}
      <Button variant="outline" isLoading={pending} onClick={refresh}>
        Проверить ещё раз
      </Button>
    </div>
  );
}
