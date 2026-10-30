"use client";
import { useEffect, useRef } from "react";
import { ImagePlus, X } from "lucide-react";
import {
  MULTI_SEP,
  splitMulti,
  type PromptField,
} from "@/lib/prompt-studio/types";
import { OptionPreview } from "./option-preview";

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

/** Picture cards (choice: pick one, again to clear) or tick chips/cards (multi). */
function Options({
  field,
  value,
  onChange,
  readOnly,
}: {
  field: PromptField;
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
}) {
  const multi = field.type === "multi";
  const picked = multi ? splitMulti(value) : [value];
  const toggle = (o: string) => {
    if (readOnly) return;
    if (!multi) return onChange(value === o ? "" : o);
    const next = picked.includes(o)
      ? picked.filter((x) => x !== o)
      : (field.options || []).filter((x) => x === o || picked.includes(x));
    onChange(next.join(MULTI_SEP));
  };
  const options = field.options || [];
  if (!field.preview)
    return (
      <span className="flex flex-wrap gap-2" role="group" aria-label={field.label}>
        {options.map((o) => {
          const on = picked.includes(o);
          return (
            <button
              type="button"
              key={o}
              role={multi ? "checkbox" : "radio"}
              aria-checked={on}
              disabled={readOnly}
              onClick={() => toggle(o)}
              className={`min-h-11 rounded-full border px-3 py-2 text-sm text-left ${on ? "border-primary bg-primary/10 font-medium" : "border-border"}`}
            >
              {multi && (on ? "✓ " : "+ ")}
              {o}
            </button>
          );
        })}
      </span>
    );
  return (
    <span
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      role={multi ? "group" : "radiogroup"}
      aria-label={field.label}
    >
      {options.map((o) => {
        const on = picked.includes(o);
        return (
          <button
            type="button"
            key={o}
            role={multi ? "checkbox" : "radio"}
            aria-checked={on}
            disabled={readOnly}
            onClick={() => toggle(o)}
            className={`rounded-xl border p-1.5 text-left transition ${on ? "border-primary ring-2 ring-primary/40" : "border-border hover:border-primary/50"}`}
          >
            <OptionPreview kind={field.preview!} option={o} />
            <span className="mt-1 block px-1 text-xs leading-tight">{o}</span>
          </button>
        );
      })}
    </span>
  );
}

/** "Add a picture": shows it here and in the live preview; it never leaves the browser. */
function Attach({
  label,
  image,
  onAttach,
}: {
  label: string;
  image?: string;
  onAttach: (file: File | null) => void;
}) {
  return image ? (
    <span className="flex items-center gap-3 rounded-lg border border-border p-2">
      {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL */}
      <img src={image} alt="" className="h-16 w-16 rounded object-contain bg-secondary" />
      <span className="flex-1 text-xs text-muted-foreground">
        Shown here only — attach the same picture in the AI tool.
      </span>
      <button
        type="button"
        className="min-h-11 min-w-11 rounded-lg border border-border"
        aria-label={`Remove picture for ${label}`}
        onClick={() => onAttach(null)}
      >
        <X className="mx-auto h-4 w-4" />
      </button>
    </span>
  ) : (
    <span className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:border-primary/60">
      <ImagePlus className="h-4 w-4" />
      Add a picture (stays on this computer)
      <input
        type="file"
        accept="image/*"
        className="sr-only"
        aria-label={`Add a picture for ${label}`}
        onChange={(e) => {
          onAttach(e.target.files?.[0] || null);
          e.target.value = "";
        }}
      />
    </span>
  );
}

export function StudioFields({
  fields,
  values,
  onChange,
  readOnly = false,
  attachments,
  onAttach,
}: {
  fields: PromptField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  readOnly?: boolean;
  attachments?: Record<string, string>;
  onAttach?: (key: string, file: File | null) => void;
}) {
  return (
    <div className="space-y-5">
      {fields.map((f) => {
        const value = values[f.key] || "";
        const set = (v: string) => onChange(f.key, v);
        const grouped = f.type === "choice" || f.type === "multi";
        // A label can't hold the picture box's own label, so those fields use a div
        // (every control still carries its own aria-label).
        const Wrapper = grouped || (f.attach && onAttach) ? "div" : "label";
        return (
          <Wrapper key={f.key} className="block space-y-1.5 text-sm">
            <span className="block font-medium">
              {f.label}
              {f.required && " *"}
            </span>
            {f.attach && onAttach && (
              <label className="block">
                <Attach
                  label={f.label}
                  image={attachments?.[f.key]}
                  onAttach={(file) => onAttach(f.key, file)}
                />
              </label>
            )}
            {grouped ? (
              <Options field={f} value={value} onChange={set} readOnly={readOnly} />
            ) : f.type === "textarea" ? (
              <GrowingTextarea
                label={f.label}
                value={value}
                onChange={set}
                placeholder={f.placeholder}
                readOnly={readOnly}
              />
            ) : f.type === "select" ? (
              <select
                aria-label={f.label}
                className="field w-full"
                value={value}
                disabled={readOnly}
                onChange={(e) => set(e.target.value)}
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
                value={value}
                placeholder={f.placeholder}
                readOnly={readOnly}
                onChange={(e) => set(e.target.value)}
              />
            )}
            {f.help && (
              <span className="block text-xs text-muted-foreground">{f.help}</span>
            )}
          </Wrapper>
        );
      })}
    </div>
  );
}
