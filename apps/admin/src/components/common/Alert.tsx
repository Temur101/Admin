import React from "react";
import { AlertCircle, CheckCircle, Info, AlertTriangle } from "lucide-react";

interface AlertProps {
  type?: "info" | "success" | "warning" | "error";
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Alert({ type = "info", title, children, className = "" }: AlertProps) {
  const styles = {
    info: {
      border: "border-ui-info-border bg-ui-info-soft text-ui-info",
      icon: <Info className="h-4 w-4 text-ui-info shrink-0" />,
    },
    success: {
      border: "border-ui-success-border bg-ui-success-soft text-ui-success",
      icon: <CheckCircle className="h-4 w-4 text-ui-success shrink-0" />,
    },
    warning: {
      border: "border-ui-warning-border bg-ui-warning-soft text-ui-warning",
      icon: <AlertTriangle className="h-4 w-4 text-ui-warning shrink-0" />,
    },
    error: {
      border: "border-ui-danger-border bg-ui-danger-soft text-ui-danger",
      icon: <AlertCircle className="h-4 w-4 text-ui-danger shrink-0" />,
    },
  };

  const current = styles[type];

  return (
    <div
      role={type === "error" ? "alert" : "status"}
      className={`flex gap-3 p-3.5 rounded-xl border text-sm leading-relaxed ${current.border} ${className}`}
    >
      {current.icon}
      <div className="space-y-0.5">
        {title && <p className="font-semibold text-current">{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  );
}
