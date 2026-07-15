import { create } from "zustand";

export interface ToastItem {
  id: number;
  message: string;
  kind: "info" | "success" | "error";
}

interface ToastStore {
  toasts: ToastItem[];
  push(t: ToastItem): void;
  dismiss(id: number): void;
}

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => set((s) => ({ toasts: [...s.toasts, t] })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

let nextId = 1;

export function toast(message: string, kind: ToastItem["kind"] = "info"): void {
  const id = nextId++;
  useToasts.getState().push({ id, message, kind });
  setTimeout(() => useToasts.getState().dismiss(id), 5000);
}
