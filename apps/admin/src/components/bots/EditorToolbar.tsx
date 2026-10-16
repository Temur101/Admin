import { Code, LayoutDashboard, Save } from "lucide-react";
import { Button } from "../common/Button.js";
export function EditorToolbar({
  title,
  description,
  mode,
  pending,
  onModeChange,
  onSave,
}: {
  title: string;
  description: string;
  mode: "visual" | "json";
  pending: boolean;
  onModeChange: (mode: "visual" | "json") => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <h3 className="text-lg font-semibold text-ui-text">{title}</h3>
        <p className="text-sm text-ui-muted mt-1">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl bg-ui-surface border border-ui-border p-1 text-sm">
          {(["visual", "json"] as const).map((value) => (
            <button
              key={value}
              type="button"
              disabled={pending}
              aria-pressed={mode === value}
              onClick={() => onModeChange(value)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg ${mode === value ? "bg-ui-accent text-ui-on-accent" : "text-ui-muted hover:text-ui-text"}`}
            >
              {value === "visual" ? (
                <LayoutDashboard className="h-4 w-4" />
              ) : (
                <Code className="h-4 w-4" />
              )}
              {value === "visual" ? "Визуальный" : "JSON"}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={onSave} isLoading={pending} icon={<Save className="h-4 w-4" />}>
          Сохранить
        </Button>
      </div>
    </div>
  );
}
