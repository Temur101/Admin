import { useQuery } from "@tanstack/react-query";
import { getBotHealth } from "../../api/bots.js";

export function BotConnectionStatus({ botId, isActive }: { botId: string; isActive: boolean }) {
  const { data, isPending, isError } = useQuery({
    queryKey: ["bot-health", botId],
    queryFn: () => getBotHealth(botId),
    enabled: isActive,
    refetchInterval: 30000,
    retry: false,
  });
  const connection = data?.connection;
  const label = !isActive
    ? "Приостановлен"
    : isError
      ? "Не удалось проверить связь"
      : isPending
        ? "Проверяем связь…"
        : connection?.status === "READY"
          ? "Подключение проверено"
          : (connection?.message ?? "Связь не проверена");
  const color = !isActive
    ? "text-ui-muted"
    : !isError && connection?.status === "READY"
      ? "text-ui-success"
      : "text-ui-warning";
  return (
    <div className={`text-sm ${color}`} role="status">
      <span className="font-semibold">{label}</span>
      {connection?.status === "READY" && isActive && !isError && (
        <p className="text-ui-muted mt-1">{connection.message}</p>
      )}
    </div>
  );
}
