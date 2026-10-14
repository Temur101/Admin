import React from "react";

interface WeekDaysPickerProps {
  selectedDays: number[];
  onChange: (days: number[]) => void;
}

const DAYS = [
  { id: 1, label: "Пн" },
  { id: 2, label: "Вт" },
  { id: 3, label: "Ср" },
  { id: 4, label: "Чт" },
  { id: 5, label: "Пт" },
  { id: 6, label: "Сб" },
  { id: 0, label: "Вс" },
];

export function WeekDaysPicker({ selectedDays, onChange }: WeekDaysPickerProps) {
  const toggleDay = (dayId: number) => {
    if (selectedDays.includes(dayId)) {
      if (selectedDays.length > 1) {
        onChange(selectedDays.filter((d) => d !== dayId));
      }
    } else {
      onChange([...selectedDays, dayId].sort((a, b) => a - b));
    }
  };

  return (
    <div className="flex items-center gap-1">
      {DAYS.map((d) => {
        const isSelected = selectedDays.includes(d.id);
        return (
          <button
            key={d.id}
            type="button"
            onClick={() => toggleDay(d.id)}
            className={`w-7 h-7 text-[11px] rounded-lg font-medium transition-colors cursor-pointer flex items-center justify-center ${
              isSelected
                ? "bg-indigo-600 text-white shadow-xs"
                : "bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700"
            }`}
          >
            {d.label}
          </button>
        );
      })}
    </div>
  );
}
