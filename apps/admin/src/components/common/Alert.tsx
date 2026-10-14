import React from "react";
import { AlertCircle, CheckCircle, Info, AlertTriangle } from "lucide-react";

interface AlertProps {
  type?: "info" | "success" | "warning" | "error";
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Alert({
  type = "info",
  title,
  children,
  className = "",
}: AlertProps) {
  const styles = {
    info: {
      border: "border-sky-500/20 bg-sky-500/10 text-sky-300",
      icon: <Info className="h-4 w-4 text-sky-400 shrink-0" />,
    },
    success: {
      border: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
      icon: <CheckCircle className="h-4 w-4 text-emerald-400 shrink-0" />,
    },
    warning: {
      border: "border-amber-500/20 bg-amber-500/10 text-amber-300",
      icon: <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />,
    },
    error: {
      border: "border-rose-500/20 bg-rose-500/10 text-rose-300",
      icon: <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />,
    },
  };

  const current = styles[type];

  return (
    <div className={`flex gap-3 p-3.5 rounded-xl border text-xs leading-relaxed ${current.border} ${className}`}>
      {current.icon}
      <div className="space-y-0.5">
        {title && <p className="font-semibold text-white">{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  );
}
