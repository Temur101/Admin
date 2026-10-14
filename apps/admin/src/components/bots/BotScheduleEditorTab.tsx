import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, Code, LayoutDashboard, Sliders } from "lucide-react";
import type { QuickBookConfig } from "@lcqb/contracts";
import type { BotDetails } from "../../api/bots.js";
import { updateBotSettings } from "../../api/templates.js";
import { Button } from "../common/Button.js";
import { Alert } from "../common/Alert.js";
import { Textarea } from "../common/Input.js";
import { ServiceList } from "./schedule/ServiceList.js";
import { ResourceList } from "./schedule/ResourceList.js";

interface BotScheduleEditorTabProps {
  bot: BotDetails;
}

const DEFAULT_CONFIG: QuickBookConfig = {
  resourceType: "STAFF",
  services: [
    { id: "haircut", name: { ru: "Стрижка мужская", uz: "Erkaklar soch turmagi" }, durationMin: 45, priceUzs: 80000 },
  ],
  resources: [
    {
      id: "master_1",
      name: { ru: "Азиз (Топ-мастер)", uz: "Aziz (Top usta)" },
      workDays: [1, 2, 3, 4, 5, 6],
      workHours: { start: "10:00", end: "20:00" },
    },
  ],
  slotIntervalMin: 30,
  bookingHorizonDays: 14,
  timezone: "Asia/Tashkent",
};

export function BotScheduleEditorTab({ bot }: BotScheduleEditorTabProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"visual" | "json">("visual");

  const [config, setConfig] = useState<QuickBookConfig>(() => {
    const raw = bot.settings as Partial<QuickBookConfig> | null;
    if (raw && Array.isArray(raw.services) && Array.isArray(raw.resources)) {
      return { ...DEFAULT_CONFIG, ...raw } as QuickBookConfig;
    }
    return DEFAULT_CONFIG;
  });

  const [jsonText, setJsonText] = useState(() => JSON.stringify(config, null, 2));
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const saveMut = useMutation({
    mutationFn: (newSettings: unknown) => updateBotSettings(bot.id, newSettings),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["bot", bot.id] });
      setSuccessMsg("Расписание и услуги QuickBook успешно сохранены.");
      setErrorMsg(null);
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || "Ошибка сохранения настроек QuickBook");
      setSuccessMsg(null);
    },
  });

  const handleModeChange = (newMode: "visual" | "json") => {
    if (newMode === "json") {
      setJsonText(JSON.stringify(config, null, 2));
    } else {
      try {
        const parsed = JSON.parse(jsonText) as QuickBookConfig;
        if (parsed.services && parsed.resources) {
          setConfig(parsed);
          setErrorMsg(null);
        }
      } catch {
        setErrorMsg("Не удалось переключиться: некорректный синтаксис JSON");
        return;
      }
    }
    setMode(newMode);
  };

  const handleSave = () => {
    setErrorMsg(null);
    if (mode === "json") {
      try {
        const parsed = JSON.parse(jsonText);
        saveMut.mutate(parsed);
      } catch {
        setErrorMsg("Ошибка синтаксиса JSON. Проверьте правильность структуры.");
      }
    } else {
      saveMut.mutate(config);
    }
  };

  const updateConfig = (partial: Partial<QuickBookConfig>) => {
    const updated = { ...config, ...partial };
    setConfig(updated);
    setJsonText(JSON.stringify(updated, null, 2));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Редактор услуг и расписания QuickBook</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Управление каталогом услуг, графиком мастеров и интервалами слотов записи
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl bg-slate-900 border border-slate-800 p-1 text-xs">
            <button
              type="button"
              onClick={() => handleModeChange("visual")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                mode === "visual" ? "bg-indigo-600 text-white font-medium" : "text-slate-400 hover:text-white"
              }`}
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              Визуальный
            </button>
            <button
              type="button"
              onClick={() => handleModeChange("json")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                mode === "json" ? "bg-indigo-600 text-white font-medium" : "text-slate-400 hover:text-white"
              }`}
            >
              <Code className="h-3.5 w-3.5" />
              JSON
            </button>
          </div>

          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            isLoading={saveMut.isPending}
            icon={<Save className="h-4 w-4" />}
          >
            Сохранить
          </Button>
        </div>
      </div>

      {successMsg && (
        <Alert type="success" title="Успешно">
          {successMsg}
        </Alert>
      )}

      {errorMsg && (
        <Alert type="error" title="Ошибка">
          {errorMsg}
        </Alert>
      )}

      {mode === "visual" ? (
        <div className="space-y-6">
          {/* Общие параметры слотов */}
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl space-y-3">
            <h4 className="text-xs font-semibold text-white flex items-center gap-2">
              <Sliders className="h-4 w-4 text-indigo-400" />
              <span>Параметры бронирования</span>
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Тип ресурсов</label>
                <select
                  value={config.resourceType}
                  onChange={(e) =>
                    updateConfig({ resourceType: e.target.value as "STAFF" | "TABLE" | "ROOM" })
                  }
                  className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="STAFF">Сотрудники / Мастера (STAFF)</option>
                  <option value="TABLE">Столы (TABLE)</option>
                  <option value="ROOM">Комнаты / Залы (ROOM)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Шаг слота (мин)</label>
                <select
                  value={config.slotIntervalMin}
                  onChange={(e) => updateConfig({ slotIntervalMin: Number(e.target.value) })}
                  className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                >
                  <option value={15}>15 минут</option>
                  <option value={30}>30 минут</option>
                  <option value={45}>45 минут</option>
                  <option value={60}>60 минут</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Горизонт записи (дней)</label>
                <select
                  value={config.bookingHorizonDays}
                  onChange={(e) => updateConfig({ bookingHorizonDays: Number(e.target.value) })}
                  className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                >
                  <option value={7}>7 дней вперед</option>
                  <option value={14}>14 дней вперед</option>
                  <option value={30}>30 дней вперед</option>
                  <option value={60}>60 дней вперед</option>
                </select>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            <ServiceList
              services={config.services}
              onChange={(services) => updateConfig({ services })}
            />
            <ResourceList
              resources={config.resources}
              services={config.services}
              onChange={(resources) => updateConfig({ resources })}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="block text-xs font-semibold text-slate-300">
            Прямое редактирование JSON:
          </label>
          <Textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            className="font-mono text-xs min-h-[400px]"
          />
        </div>
      )}
    </div>
  );
}
