import React, { useId } from "react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export function Input({ label, error, helperText, className = "", id, ...props }: InputProps) {
  const generatedId = useId();
  const inputId = id || props.name || generatedId;

  return (
    <div className="w-full space-y-1.5">
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium text-ui-secondary">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`w-full min-h-11 px-3.5 py-2.5 bg-ui-surface border rounded-xl text-sm text-ui-text placeholder-ui-muted focus:outline-hidden focus:ring-2 focus:ring-ui-accent focus:border-ui-accent transition-all ${
          error
            ? "border-ui-danger-border ring-ui-danger"
            : "border-ui-border hover:border-ui-border"
        } ${className}`}
        {...props}
      />
      {error && <p className="text-sm text-ui-danger font-medium">{error}</p>}
      {!error && helperText && <p className="text-sm text-ui-muted">{helperText}</p>}
    </div>
  );
}

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export function Textarea({
  label,
  error,
  helperText,
  className = "",
  id,
  ...props
}: TextareaProps) {
  const generatedId = useId();
  const textareaId = id || props.name || generatedId;

  return (
    <div className="w-full space-y-1.5">
      {label && (
        <label htmlFor={textareaId} className="block text-sm font-medium text-ui-secondary">
          {label}
        </label>
      )}
      <textarea
        id={textareaId}
        className={`w-full min-h-11 px-3.5 py-2.5 bg-ui-surface border rounded-xl text-sm text-ui-text placeholder-ui-muted focus:outline-hidden focus:ring-2 focus:ring-ui-accent focus:border-ui-accent transition-all resize-y min-h-[80px] ${
          error
            ? "border-ui-danger-border ring-ui-danger"
            : "border-ui-border hover:border-ui-border"
        } ${className}`}
        {...props}
      />
      {error && <p className="text-sm text-ui-danger font-medium">{error}</p>}
      {!error && helperText && <p className="text-sm text-ui-muted">{helperText}</p>}
    </div>
  );
}
