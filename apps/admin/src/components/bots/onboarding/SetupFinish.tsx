import { useState } from "react";
import type { BotDetails } from "../../../api/bots.js";
import { BotConnectionStatus } from "../BotConnectionStatus.js";
import { Button } from "../../common/Button.js";
import { Alert } from "../../common/Alert.js";

export function SetupFinish({ bot, onFinish }: { bot: BotDetails; onFinish: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [tested, setTested] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(bot.inviteLink!);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-ui-text">Бот включён</h2>
      <BotConnectionStatus botId={bot.id} isActive />
      <p className="text-sm text-ui-secondary">
        Откройте бота как клиент, нажмите /start и пройдите сценарий. Затем передайте владельцу
        ссылку для получения прав администратора.
      </p>
      {bot.botUsername && (
        <a
          href={`https://t.me/${bot.botUsername}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex rounded-xl bg-ui-accent px-4 py-3 text-ui-on-accent"
        >
          Проверить диалог в Telegram
        </a>
      )}
      {bot.inviteLink && (
        <div className="space-y-2">
          <label htmlFor="setup-invite" className="text-sm font-medium">
            Ссылка для владельца
          </label>
          <input
            id="setup-invite"
            readOnly
            value={bot.inviteLink}
            className="w-full rounded-xl border border-ui-border p-3 text-sm bg-ui-subtle"
          />
          <Button variant="outline" onClick={() => void copy()}>
            {copied ? "Ссылка скопирована" : "Копировать ссылку владельца"}
          </Button>
          {copyError && (
            <Alert type="warning">
              Браузер не разрешил копирование. Скопируйте ссылку из поля вручную.
            </Alert>
          )}
        </div>
      )}
      <label className="flex items-start gap-3 text-sm text-ui-secondary">
        <input
          type="checkbox"
          checked={tested}
          onChange={(event) => setTested(event.target.checked)}
          className="mt-1 accent-ui-accent"
        />
        Я проверил диалог в Telegram
      </label>
      <Button disabled={!tested} onClick={onFinish}>
        Завершить настройку
      </Button>
    </div>
  );
}
