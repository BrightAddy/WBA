import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";

const LENGTH = 6;

/**
 * Six boxes backed by one string. Supports paste, SMS/WhatsApp autofill
 * (autocomplete=one-time-code on the first box), arrow keys and backspace.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  invalid,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete: (v: string) => void;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const focus = (i: number) => refs.current[Math.max(0, Math.min(LENGTH - 1, i))]?.focus();

  const commit = (next: string, focusAt: number) => {
    const clean = next.replace(/\D/g, "").slice(0, LENGTH);
    onChange(clean);
    focus(focusAt);
    if (clean.length === LENGTH) onComplete(clean);
  };

  const onInput = (i: number, raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (!digits) return;
    // Autofill or fast typing can drop several digits into one box.
    const chars = value.padEnd(LENGTH, " ").split("");
    digits.split("").forEach((d, k) => {
      if (i + k < LENGTH) chars[i + k] = d;
    });
    commit(chars.join("").replace(/ /g, ""), i + digits.length);
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      const target = value[i] ? i : i - 1;
      if (target < 0) return;
      commit(value.slice(0, target) + value.slice(target + 1), target);
    } else if (e.key === "ArrowLeft") focus(i - 1);
    else if (e.key === "ArrowRight") focus(i + 1);
  };

  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const digits = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, LENGTH);
    if (digits) commit(digits, digits.length);
  };

  return (
    <div className={`flex gap-2 ${invalid ? "shake" : ""}`} role="group" aria-label="6-digit code" onPaste={onPaste}>
      {Array.from({ length: LENGTH }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={value[i] ?? ""}
          onChange={(e) => onInput(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onFocus={(e) => e.target.select()}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={i === 0 ? LENGTH : 1}
          autoFocus={i === 0}
          disabled={disabled}
          aria-label={`Digit ${i + 1}`}
          className={`h-14 w-full min-w-0 rounded-md border bg-raised text-center font-display text-2xl font-bold tabular-nums outline-none transition-colors focus:border-fg ${
            invalid ? "border-danger" : value[i] ? "border-fg" : "border-line-strong"
          }`}
        />
      ))}
    </div>
  );
}
