import React from "react";
import { Plus, Trash2 } from "lucide-react";
import type { QuickBookService } from "@lcqb/contracts";
import { Button } from "../../common/Button.js";

interface ServiceListProps {
  services: QuickBookService[];
  onChange: (services: QuickBookService[]) => void;
}

const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120, 180];

export function ServiceList({ services, onChange }: ServiceListProps) {
  const handleUpdate = (idx: number, updated: QuickBookService) => {
    const next = [...services];
    next[idx] = updated;
    onChange(next);
  };

  const handleDelete = (idx: number) => {
    if (services.length <= 1) return;
    onChange(services.filter((_, i) => i !== idx));
  };

  const handleAdd = () => {
    const newService: QuickBookService = {
      id: `srv_${Date.now().toString(36)}`,
      name: { ru: `Новая услуга ${services.length + 1}`, uz: `Yangi xizmat ${services.length + 1}` },
      durationMin: 30,
      priceUzs: 50000,
    };
    onChange([...services, newService]);
  };

  return (
    <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-xs font-semibold text-white">Список услуг ({services.length})</h4>
          <p className="text-[11px] text-slate-400">Название, длительность сеанса и стоимость</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleAdd}
          icon={<Plus className="h-3.5 w-3.5" />}
        >
          Добавить услугу
        </Button>
      </div>

      <div className="space-y-3">
        {services.map((srv, idx) => (
          <div
            key={srv.id}
            className="p-3 bg-slate-950/70 border border-slate-800 rounded-xl space-y-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-md border border-indigo-500/20">
                {srv.id}
              </span>
              <button
                type="button"
                onClick={() => handleDelete(idx)}
                disabled={services.length <= 1}
                title={services.length <= 1 ? "Минимум 1 услуга" : "Удалить услугу"}
                className="p-1 rounded-md text-slate-400 hover:text-rose-400 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text"
                value={srv.name.ru}
                onChange={(e) =>
                  handleUpdate(idx, { ...srv, name: { ...srv.name, ru: e.target.value } })
                }
                placeholder="Название (RU)"
                className="px-2.5 py-1.5 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
              />
              <input
                type="text"
                value={srv.name.uz}
                onChange={(e) =>
                  handleUpdate(idx, { ...srv, name: { ...srv.name, uz: e.target.value } })
                }
                placeholder="Название (UZ)"
                className="px-2.5 py-1.5 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-slate-400 mb-0.5">Длительность (мин)</label>
                <select
                  value={srv.durationMin}
                  onChange={(e) =>
                    handleUpdate(idx, { ...srv, durationMin: Number(e.target.value) })
                  }
                  className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-white focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                >
                  {DURATION_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d} минут
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] text-slate-400 mb-0.5">Цена (UZS)</label>
                <input
                  type="number"
                  min="0"
                  step="5000"
                  value={srv.priceUzs}
                  onChange={(e) =>
                    handleUpdate(idx, { ...srv, priceUzs: Math.max(0, Number(e.target.value)) })
                  }
                  className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-white focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
