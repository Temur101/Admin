import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getFailedNotifications, retryNotification } from "../../api/bots.js";
import { Button } from "../common/Button.js";
import { Alert } from "../common/Alert.js";

export function NotificationFailures({ botId, count }: { botId: string; count: number }) {
  const client = useQueryClient();
  const failures = useQuery({
    queryKey: ["notification-errors", botId],
    queryFn: () => getFailedNotifications(botId),
    enabled: count > 0,
  });
  const retry = useMutation({
    mutationFn: retryNotification,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["notification-errors", botId] });
      await client.invalidateQueries({ queryKey: ["bot-health", botId] });
    },
  });
  if (!count) return null;
  return (
    <Alert type="warning" title="Уведомления требуют внимания">
      <p>Проверьте связь с Telegram и доступ владельца к боту, затем повторите доставку.</p>
      {(failures.error || retry.error) && (
        <p role="alert">{(failures.error || retry.error)?.message}</p>
      )}
      {failures.data?.map((item) => (
        <div key={item.id} className="flex items-center justify-between gap-3 mt-2">
          <span>
            {new Date(item.createdAt).toLocaleString("ru-RU")} · Попыток: {item.attempts}
          </span>
          <Button
            variant="outline"
            size="sm"
            isLoading={retry.isPending && retry.variables === item.id}
            onClick={() => retry.mutate(item.id)}
          >
            Повторить доставку
          </Button>
        </div>
      ))}
    </Alert>
  );
}
