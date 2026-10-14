import React from "react";
import { Plus, Trash2 } from "lucide-react";
import type { QuickBookResource, QuickBookService } from "@lcqb/contracts";
import { Button } from "../../common/Button.js";
import { WeekDaysPicker } from "./WeekDaysPicker.js";

interface ResourceListProps {
  resources: QuickBookResource[];
  services: QuickBookService[];
  onChange: (resources: QuickBookResource[]) => void;
}

export function ResourceList({ resources, services, onChange }: ResourceListProps) {
  const handleUpdate = (idx: number, updated: QuickBookResource) => {
    const next = [...resources];
    next[idx] = updated;
    onChange(next);
  };

  const handleDelete = (idx: number) => {
    if (resources.length <= 1) return;
    onChange(resources.filter((_, i) => i !== idx));
  };

  const handleAdd = () => {
    const newResource: QuickBookResource = {
      id: `master_${Date.now().toString(36)}`,
      name: { ru: `Мастер ${resources.length + 1}`, uz: `Usta ${resources.length + 1}` },
      workDays: [1, 2, 3, 4, 5, 6],
      workHours: { start: "09:00", end: "19:00" },
      serviceIds: services.map((s) => s.id),
    };
    onChange([...resources, newResource]);
  };

  const toggleServiceAssignment = (resourceIdx: number, serviceId: string) => {
    const res = resources[resourceIdx];
    if (!res) return;
    const currentAssigned = res.serviceIds ?? services.map((s) => s.id);
    const newAssigned = currentAssigned.includes(serviceId)
      ? currentAssigned.filter((id) => id !== serviceId)
      : [...currentAssigned, serviceId];
    handleUpdate(resourceIdx, { ...res, serviceIds: newAssigned });
  };

  return (
    <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-xs font-semibold text-white">
            Мастера и ресурсы ({resources.length})
          </h4>
          <p className="text-[11px] text-slate-400">График работы, смены и закрепленные услуги</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleAdd}
          icon={<Plus className="h-3.5 w-3.5" />}
        >
          Добавить мастера
        </Button>
      </div>

      <div className="space-y-4">
        {resources.map((res, idx) => {
          const assigned = res.serviceIds ?? services.map((s) => s.id);
          return (
            <div
              key={res.id}
              className="p-3.5 bg-slate-950/70 border border-slate-800 rounded-xl space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded-md border border-purple-500/20">
                  {res.id}
                </span>
                <button
                  type="button"
                  onClick={() => handleDelete(idx)}
                  disabled={resources.length <= 1}
                  title={resources.length <= 1 ? "Минимум 1 ресурс" : "Удалить мастера"}
                  className="p-1 rounded-md text-slate-400 hover:text-rose-400 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="text"
                  value={res.name.ru}
                  onChange={(e) =>
                    handleUpdate(idx, { ...res, name: { ...res.name, ru: e.target.value } })
                  }
                  placeholder="Имя / название (RU)"
                  className="px-2.5 py-1.5 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                />
                <input
                  type="text"
                  value={res.name.uz}
                  onChange={(e) =>
                    handleUpdate(idx, { ...res, name: { ...res.name, uz: e.target.value } })
                  }
                  placeholder="Имя / название (UZ)"
                  className="px-2.5 py-1.5 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 border-t border-slate-850">
                <div className="space-y-1">
                  <span className="text-[10px] text-slate-400">Рабочие дни недели:</span>
                  <WeekDaysPicker
                    selectedDays={res.workDays}
                    onChange={(days) => handleUpdate(idx, { ...res, workDays: days })}
                  />
                </div>

                <div className="space-y-1">
                  <span className="text-[10px] text-slate-400">Часы смены:</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="time"
                      value={res.workHours.start}
                      onChange={(e) =>
                        handleUpdate(idx, {
                          ...res,
                          workHours: { ...res.workHours, start: e.target.value },
                        })
                      }
                      className="px-2 py-1 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-white focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                    />
                    <span className="text-slate-500 text-xs">-</span>
                    <input
                      type="time"
                      value={res.workHours.end}
                      onChange={(e) =>
                        handleUpdate(idx, {
                          ...res,
                          workHours: { ...res.workHours, end: e.target.value },
                        })
                      }
                      className="px-2 py-1 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-white focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              </div>

              {services.length > 0 && (
                <div className="space-y-1.5 pt-1 border-t border-slate-850">
                  <span className="text-[10px] text-slate-400">Предоставляемые услуги:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {services.map((s) => {
                      const isChecked = assigned.includes(s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => toggleServiceAssignment(idx, s.id)}
                          className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer border ${
                            isChecked
                              ? "bg-indigo-600/20 border-indigo-500/40 text-indigo-300"
                              : "bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300"
                          }`}
                        >
                          {isChecked ? "✓ " : "+ "}
                          {s.name.ru}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
