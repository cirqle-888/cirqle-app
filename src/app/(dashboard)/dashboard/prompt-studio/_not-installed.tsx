import { Database } from "lucide-react";

export function NotInstalled() {
  return (
    <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-5">
      <div className="flex items-start gap-3">
        <Database className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div className="space-y-2 text-sm">
          <h2 className="font-semibold">Prompt Studio isn’t set up yet</h2>
          <p>
            Built-in templates, Copy and Skills are ready to use. To save cards,
            templates and prompts, apply{" "}
            <code className="break-all">
              supabase/migrations/20261028120000_prompt_studio.sql
            </code>{" "}
            and then{" "}
            <code className="break-all">
              20261031090000_prompt_studio_flyer.sql
            </code>{" "}
            in the Supabase SQL editor.
          </p>
        </div>
      </div>
    </section>
  );
}
