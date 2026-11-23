/**
 * Odometer-style amount. Each digit is a vertical strip translated to its
 * value, so changes roll instead of snapping. Pure CSS transform; screen
 * readers get the plain value.
 */
export function RollingNumber({ value, className = "" }: { value: string; className?: string }) {
  return (
    <span className={`inline-flex tabular-nums ${className}`} aria-label={value} role="text">
      {value.split("").map((ch, i) => {
        const digit = /\d/.test(ch) ? Number(ch) : null;
        if (digit === null) {
          return (
            <span key={`${i}-${ch}`} aria-hidden>
              {ch}
            </span>
          );
        }
        return (
          // Key from the right so units stay units when the number grows.
          <span key={`d${value.length - i}`} aria-hidden className="relative inline-block h-[1em] overflow-hidden leading-none">
            <span className="invisible">0</span>
            <span
              className="absolute left-0 top-0 flex flex-col transition-transform duration-[var(--dur-slow)] ease-[var(--ease-out)]"
              style={{ transform: `translateY(-${digit * 10}%)` }}
            >
              {"0123456789".split("").map((d) => (
                <span key={d} className="h-[1em] leading-none">
                  {d}
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
