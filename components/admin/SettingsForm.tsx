"use client";

import { useState } from "react";
import { LANGUAGES, MODEL_INFO } from "@/lib/config";
import { toast } from "@/lib/toast";
import type { ModelId } from "@/lib/types";
import type { PlatformSettings } from "@/lib/server/redis";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-line px-5 py-4 last:border-0 sm:grid sm:grid-cols-[220px_minmax(0,1fr)] sm:items-start sm:gap-6">
      <div className="mb-2 sm:mb-0">
        <p className="text-[13.5px] font-semibold text-ink">{label}</p>
        {hint ? <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{hint}</p> : null}
      </div>
      <div className="max-w-sm">{children}</div>
    </div>
  );
}

export function SettingsForm({
  initial,
  canSave,
}: {
  initial: PlatformSettings;
  canSave: boolean;
}) {
  const [values, setValues] = useState<PlatformSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  function patch(next: Partial<PlatformSettings>) {
    setValues((v) => ({ ...v, ...next }));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast(data.error ?? "Couldn't save settings.", "error");
        return;
      }
      setDirty(false);
      toast("Settings saved.", "success");
    } catch {
      toast("Couldn't reach the server.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="glass-card overflow-hidden">
      <Field
        label="Default model"
        hint="Used by the studio and the public API when a request doesn't name one."
      >
        <Select
          value={values.defaultModel}
          onChange={(e) => patch({ defaultModel: e.target.value as ModelId })}
        >
          {(Object.keys(MODEL_INFO) as ModelId[]).map((id) => (
            <option key={id} value={id}>
              {MODEL_INFO[id].name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Default language" hint="Nepali uses its own fine-tuned model, with a Hindi fallback.">
        <Select
          value={values.defaultLanguage}
          onChange={(e) => patch({ defaultLanguage: e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Audio retention"
        hint="Generated audio is deleted from storage after this many days."
      >
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={365}
            value={values.retentionDays}
            onChange={(e) =>
              patch({ retentionDays: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })
            }
            className="w-28 font-mono tabular-nums"
          />
          <span className="text-[13px] text-muted">days</span>
        </div>
      </Field>

      <Field
        label="Kaggle notebook URL"
        hint="Shown in the Backends connect dialog once that page exists."
      >
        <Input
          type="url"
          placeholder="https://www.kaggle.com/code/…"
          value={values.kaggleNotebookUrl}
          onChange={(e) => patch({ kaggleNotebookUrl: e.target.value })}
          className="font-mono text-xs"
        />
      </Field>

      <div className="flex items-center justify-between gap-4 bg-surface2 px-5 py-3.5">
        <p className="text-[12.5px] text-muted">
          {!canSave
            ? "Connect Upstash Redis to save changes."
            : dirty
              ? "You have unsaved changes."
              : "All changes saved."}
        </p>
        <Button variant="primary" disabled={!canSave || saving || !dirty} onClick={() => void save()}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
