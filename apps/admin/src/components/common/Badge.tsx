import React from "react";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "success" | "warning" | "danger" | "info" | "neutral" | "purple";
  size?: "sm" | "md";
}

export function Badge({ children, variant = "neutral", size = "sm" }: BadgeProps) {
  const variantStyles = {
    success: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    warning: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    danger: "bg-rose-500/15 text-rose-400 border-rose-500/30",
    info: "bg-sky-500/15 text-sky-400 border-sky-500/30",
    purple: "bg-purple-500/15 text-purple-400 border-purple-500/30",
    neutral: "bg-slate-700/50 text-slate-300 border-slate-600",
  };

  const sizeStyles = {
    sm: "px-2 py-0.5 text-xs",
    md: "px-2.5 py-1 text-sm",
  };

  return (
    <span
      className={`inline-flex items-center font-medium rounded-full border ${variantStyles[variant]} ${sizeStyles[size]}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return <Badge variant="success">Активна</Badge>;
    case "TRIAL":
      return <Badge variant="info">Пробный период</Badge>;
    case "GRACE_PERIOD":
      return <Badge variant="warning">Льготный период</Badge>;
    case "EXPIRED":
      return <Badge variant="danger">Истекла</Badge>;
    case "BLOCKED":
      return <Badge variant="danger">Заблокирован</Badge>;
    case "SUSPENDED":
      return <Badge variant="neutral">Приостановлен</Badge>;
    case "PENDING":
      return <Badge variant="warning">Ожидает</Badge>;
    case "APPROVED":
      return <Badge variant="success">Одобрен</Badge>;
    case "REJECTED":
      return <Badge variant="danger">Отклонен</Badge>;
    default:
      return <Badge variant="neutral">{status}</Badge>;
  }
}
