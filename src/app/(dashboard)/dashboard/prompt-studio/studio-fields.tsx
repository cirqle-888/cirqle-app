"use client";
import { useEffect, useRef } from "react";
import type { PromptField } from "@/lib/prompt-studio/types";
export function GrowingTextarea({
  value,
  onChange,
  label,
  placeholder,
  readOnly = false,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${ref.current.scrollHeight}px`;
    }
  }, [value]);
  return (
    <textarea
      ref={ref}
      aria-label={label}
      className="field w-full min-h-24 resize-y"
      rows={3}
      value={value}
      placeholder={placeholder}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
export function StudioFields({
  fields,
  values,
  onChange,
  readOnly = false,
}: {
  fields: PromptField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="space-y-4">
      {fields.map((f) => (
        <label key={f.key} className="block space-y-1.5 text-sm">
          <span className="font-medium">
            {f.label}
            {f.required && " *"}
          </span>
          {f.type === "textarea" ? (
            <GrowingTextarea
              label={f.label}
              value={values[f.key] || ""}
              onChange={(v) => onChange(f.key, v)}
              placeholder={f.placeholder}
              readOnly={readOnly}
            />
          ) : f.type === "select" ? (
            <select
              aria-label={f.label}
              className="field w-full"
              value={values[f.key] || ""}
              disabled={readOnly}
              onChange={(e) => onChange(f.key, e.target.value)}
            >
              <option value="">Choose…</option>
              {(f.options || []).map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              aria-label={f.label}
              className={`field ${f.type === "number" ? "w-32 block" : "w-full"}`}
              type={f.type}
              value={values[f.key] || ""}
              placeholder={f.placeholder}
              readOnly={readOnly}
              onChange={(e) => onChange(f.key, e.target.value)}
            />
          )}
          {f.help && (
            <span className="block text-xs text-muted-foreground">
              {f.help}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}
