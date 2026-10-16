import { Alert } from "./Alert.js";
import { describeApiError } from "../../utils/api-errors.js";

export function ApiErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const { message, details } = describeApiError(error);
  return (
    <Alert type="error" title="Не удалось выполнить действие">
      <p>{message}</p>
      {details.length > 0 && (
        <ul className="list-disc list-inside mt-2 space-y-1">
          {details.map((detail, index) => (
            <li key={index}>{detail}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}
