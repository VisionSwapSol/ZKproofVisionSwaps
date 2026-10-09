import { useState } from "react";
import { cleanAmount, AMOUNT_HINT } from "../../lib/amount";

/**
 * Every amount box: "0,5" and "0.5" both mean a half, and text that could be read two ways
 * is refused with a hint instead of being guessed. The value handed on is always "0.5" style.
 */
export function AmountField({
  label,
  value,
  onChange,
  max,
  unit = "SOL",
  pre,
  hint,
  placeholder = "0.00",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max?: string | null;
  unit?: string;
  /** a sign before the number, like "$" */
  pre?: string;
  hint?: string;
  placeholder?: string;
}) {
  const [refused, setRefused] = useState(false);
  return (
    <label className="field">
      <span className="field-top">
        <span>{label}</span>
        {hint && <span className="muted">{hint}</span>}
      </span>
      <span className="amount">
        {pre && <span className="unit pre">{pre}</span>}
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            const v = cleanAmount(e.target.value);
            setRefused(v == null);
            if (v != null) onChange(v);
          }}
          placeholder={placeholder}
          autoComplete="off"
        />
        <span className="unit">{unit}</span>
        {max != null && (
          // the most is written by this page in en-US style, so any comma in it groups thousands
          <button type="button" className="max" onClick={() => (setRefused(false), onChange(max.replace(/,/g, "")))}>
            Max
          </button>
        )}
      </span>
      {refused && (
        <span className="field-hint" role="status">
          {AMOUNT_HINT}
        </span>
      )}
    </label>
  );
}
