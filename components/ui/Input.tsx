"use client";

import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

const FIELD =
  "w-full rounded-xl border border-line bg-surface2 px-3.5 text-sm text-ink transition-colors placeholder:text-faint hover:border-lineStrong focus:border-audio/60 focus:bg-surface3 focus:outline-none";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...props }, ref) {
    return <input ref={ref} className={`${FIELD} h-10 ${className}`} {...props} />;
  }
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = "", ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={`${FIELD} resize-none py-3 leading-relaxed ${className}`}
      {...props}
    />
  );
});
