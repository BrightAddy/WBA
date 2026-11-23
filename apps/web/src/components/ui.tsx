import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

export function Button({
  variant = "primary",
  busy,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet"; busy?: boolean }) {
  const base =
    "relative inline-flex items-center justify-center gap-2 font-medium transition-[transform,background-color,color] duration-150 ease-out active:scale-[0.98]";
  const styles = {
    primary: "h-12 rounded-md px-5 text-[15px] bg-ink text-[color:var(--chalk)] hover:bg-[color:var(--ink-3)] disabled:opacity-40",
    secondary: "h-12 rounded-md px-5 text-[15px] border border-line-strong bg-raised hover:border-fg disabled:opacity-40",
    quiet: "text-muted hover:text-fg underline-offset-4 hover:underline disabled:opacity-40",
  }[variant];
  return (
    <button className={`${base} ${styles} ${className}`} aria-busy={busy || undefined} {...rest}>
      <span className={busy ? "opacity-0" : undefined}>{children}</span>
      {busy && (
        <span className="absolute inset-0 grid place-items-center" aria-hidden>
          <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
        </span>
      )}
    </button>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: string;
  prefix?: string;
};

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, prefix, className = "", ...rest },
  ref,
) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <div
        className={`flex h-12 items-center rounded-md border bg-raised transition-colors focus-within:border-fg ${
          error ? "border-danger" : "border-line-strong"
        }`}
      >
        {prefix && <span className="pl-3.5 pr-1 text-muted select-none">{prefix}</span>}
        <input
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`h-full w-full min-w-0 bg-transparent outline-none placeholder:text-faint ${prefix ? "pr-3.5" : "px-3.5"}`}
          {...rest}
        />
      </div>
      {error ? (
        <p id={`${id}-err`} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

export function Wordmark() {
  return (
    <span className="font-display text-xl font-extrabold tracking-[-0.04em]">
      kiosk<span className="text-accent">.</span>
    </span>
  );
}
