"use client";

import { forwardRef, type SelectHTMLAttributes } from "react";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = "", children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={`w-full appearance-none rounded-md border border-rule bg-desk px-3 py-2 text-sm text-text focus:border-muted ${className}`}
        {...props}
      >
        {children}
      </select>
    );
  }
);
