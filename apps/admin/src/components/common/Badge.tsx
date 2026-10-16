import React from "react";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "success" | "warning" | "danger" | "info" | "neutral" | "purple";
  size?: "sm" | "md";
}

export function Badge({ children, variant = "neutral", size = "sm" }: BadgeProps) {
  const variantStyles = {
    success: "bg-ui-success-soft text-ui-success border-ui-success-border",
    warning: "bg-ui-warning-soft text-ui-warning border-ui-warning-border",
    danger: "bg-ui-danger-soft text-ui-danger border-ui-danger-border",
    info: "bg-ui-info-soft text-ui-info border-ui-info-border",
    purple: "bg-ui-accent-soft text-ui-accent border-ui-accent-border",
    neutral: "bg-ui-hover text-ui-secondary border-ui-border",
  };

  const sizeStyles = {
    sm: "px-2 py-0.5 text-sm",
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
    case "UNKNOWN":
      return <Badge variant="neutral">Неизвестен</Badge>;
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
