"use client";

import { useId } from "react";

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  hint?: string;
  format?(value: number): string;
  disabled?: boolean;
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
  format = (v) => v.toFixed(2),
  disabled,
}: SliderProps) {
  const id = useId();
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label htmlFor={id} className="text-xs font-medium text-muted">
          {label}
        </label>
        <span className="font-mono text-xs tabular-nums text-text">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-rule accent-[#E4E6ED] disabled:cursor-not-allowed disabled:opacity-40"
      />
      {hint ? <p className="mt-1 text-[11px] leading-snug text-muted/80">{hint}</p> : null}
    </div>
  );
}
