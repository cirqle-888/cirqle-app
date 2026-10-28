"use client";
import { useState } from "react";
import { PROMPT_SKILLS } from "@/lib/prompt-studio/skills";
import { buildSkillArchive } from "@/lib/prompt-studio/skill-archive";

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function SkillsTab({
  copy,
  error,
}: {
  copy: (text: string) => Promise<void>;
  error: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function zip(skills: typeof PROMPT_SKILLS, name: string) {
    setBusy(true);
    try {
      const bytes = await buildSkillArchive(skills);
      download(
        new Blob([new Uint8Array(bytes)], { type: "application/zip" }),
        name,
      );
    } catch {
      error("Could not download the skills. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Skills for video work</h2>
        <button
          className="studio-button"
          disabled={busy}
          onClick={() => zip(PROMPT_SKILLS, "prompt-studio-skills.zip")}
        >
          Download all (.zip)
        </button>
      </div>
      <section className="bg-card border border-border rounded-xl p-5 space-y-3">
        <h3 className="font-semibold">How to use</h3>
        <ol className="list-decimal pl-5 space-y-2 text-sm text-muted-foreground">
          <li>
            In Claude (web or desktop), go to Settings → Capabilities → Skills,
            upload the .zip, and switch it on.
          </li>
          <li>
            Claude Code needs nothing more; the skills are already in this
            project.
          </li>
          <li>
            To add or improve a template, ask Claude: “use
            prompt-template-builder to add templates for …”.
          </li>
        </ol>
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        {PROMPT_SKILLS.map((s) => (
          <section
            key={s.name}
            className="min-w-0 bg-card border border-border rounded-xl p-5 space-y-3"
          >
            <h3 className="font-semibold">{s.title}</h3>
            <p className="text-sm text-muted-foreground">{s.summary}</p>
            <div className="flex flex-wrap gap-2">
              <button
                className="studio-button"
                disabled={busy}
                onClick={() => zip([s], `${s.name}.zip`)}
              >
                Download .zip
              </button>
              <button
                className="studio-button"
                onClick={() =>
                  download(
                    new Blob([s.content], {
                      type: "text/markdown;charset=utf-8",
                    }),
                    "SKILL.md",
                  )
                }
              >
                Download SKILL.md
              </button>
              <button className="studio-button" onClick={() => copy(s.content)}>
                Copy
              </button>
            </div>
            <details>
              <summary className="cursor-pointer py-3 text-sm font-medium">
                View
              </summary>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-secondary p-4 text-xs">
                {s.content}
              </pre>
            </details>
          </section>
        ))}
      </div>
    </div>
  );
}
