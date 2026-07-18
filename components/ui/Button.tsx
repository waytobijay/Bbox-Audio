"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "video" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  // Primary = the audio/brand action. Solid mint, dark ink — high contrast.
  primary:
    "bg-audio text-[#06231A] font-semibold hover:brightness-110 active:brightness-95 shadow-[0_4px_16px_-6px_rgba(74,222,159,.5)]",
  // The same weight, for the video half of the product.
  video:
    "bg-video text-[#0A1330] font-semibold hover:brightness-110 active:brightness-95 shadow-[0_4px_16px_-6px_rgba(124,155,255,.5)]",
  secondary:
    "border border-line bg-surface2 text-ink hover:border-lineStrong hover:bg-surface3",
  ghost: "text-muted hover:text-ink hover:bg-surface2",
  danger: "border border-danger/30 bg-dangerSoft text-danger hover:border-danger/60",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] rounded-lg gap-1.5",
  md: "h-10 px-4 text-sm rounded-xl gap-2",
  lg: "h-12 px-6 text-[15px] rounded-xl gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className = "", type = "button", ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex select-none items-center justify-center whitespace-nowrap transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    />
  );
});
