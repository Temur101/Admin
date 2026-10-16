import React from "react";
import { Loader2 } from "lucide-react";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "outline";
  size?: "sm" | "md" | "lg";
  isLoading?: boolean;
  icon?: React.ReactNode;
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  isLoading = false,
  disabled,
  icon,
  className = "",
  ...props
}: ButtonProps) {
  const variantStyles = {
    primary:
      "bg-ui-accent hover:bg-ui-accent-hover text-ui-on-accent shadow-sm border border-ui-accent-border",
    secondary: "bg-ui-subtle hover:bg-ui-hover text-ui-text border border-ui-border",
    danger:
      "bg-ui-danger hover:brightness-95 text-ui-on-accent shadow-sm border border-ui-danger-border",
    outline: "bg-transparent hover:bg-ui-hover text-ui-secondary border border-ui-border",
    ghost:
      "bg-transparent hover:bg-ui-hover text-ui-muted hover:text-ui-text border border-transparent",
  };

  const sizeStyles = {
    sm: "min-h-9 px-3 py-2 text-sm rounded-lg gap-1.5",
    md: "min-h-11 px-4 py-2.5 text-sm rounded-xl gap-2",
    lg: "min-h-12 px-5 py-3 text-base rounded-xl gap-2.5",
  };

  return (
    <button
      disabled={disabled || isLoading}
      className={`inline-flex items-center justify-center font-medium transition-all active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none cursor-pointer ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...props}
    >
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-current" />
      ) : (
        icon && <span className="shrink-0">{icon}</span>
      )}
      <span>{children}</span>
    </button>
  );
}
