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
    <div className="flex flex-wrap items-center gap-1">
      {DAYS.map((d) => {
        const isSelected = selectedDays.includes(d.id);
        return (
          <button
            key={d.id}
            type="button"
            aria-pressed={isSelected}
            onClick={() => toggleDay(d.id)}
            className={`w-7 h-7 text-sm rounded-lg font-medium transition-colors cursor-pointer flex items-center justify-center ${
              isSelected
                ? "bg-ui-accent text-ui-on-accent shadow-xs"
                : "bg-ui-surface border border-ui-border text-ui-muted hover:text-ui-text hover:border-ui-border"
            }`}
          >
            {d.label}
          </button>
        );
      })}
    </div>
  );
}
