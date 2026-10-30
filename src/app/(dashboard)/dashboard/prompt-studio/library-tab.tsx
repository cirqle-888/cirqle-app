"use client";
/**
 * Library: saved prompts, newest first. Filters and search run on the server,
 * 50 at a time, so old prompts stay findable without loading the whole library.
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import {
  LIBRARY_PAGE,
  type ActionResult,
  type LibraryItem,
  type PromptTemplate,
  type StudioClient,
} from "@/lib/prompt-studio/types";
import * as actions from "./actions";

const panel = "bg-card border border-border rounded-xl p-4 sm:p-6 space-y-4 min-w-0";

export function LibraryTab({
  clients,
  templates,
  library,
  setLibrary,
  myId,
  canManage,
  busy,
  run,
  copy,
  onOpen,
}: {
  clients: StudioClient[];
  templates: PromptTemplate[];
  library: LibraryItem[];
  setLibrary: Dispatch<SetStateAction<LibraryItem[]>>;
  myId: string | null;
  canManage: boolean;
  busy: boolean;
  run: <T>(action: () => Promise<ActionResult<T>>, done: (data: T) => void, message?: string) => Promise<void>;
  copy: (text: string) => Promise<void>;
  onOpen: (item: LibraryItem) => void;
}) {
  const [search, setSearch] = useState("");
  const [clientId, setClientId] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(library.length >= LIBRARY_PAGE);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const first = useRef(true);
  const query = { search, clientId, templateKey, favorites };

  async function load(before?: string) {
    setLoading(true);
    setError("");
    try {
      const r = await actions.loadLibrary({ ...query, before });
      if (!r.ok || !r.data) {
        setError(r.error || "Could not load saved prompts.");
        return;
      }
      const rows = r.data;
      setLibrary((s) => (before ? [...s, ...rows] : rows));
      setMore(rows.length >= LIBRARY_PAGE);
    } catch {
      setError("Could not load saved prompts.");
    } finally {
      setLoading(false);
    }
  }

  // Reload from the server when a filter changes (typing waits a moment).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => void load(), search ? 350 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load reads the same four filters
  }, [search, clientId, templateKey, favorites]);

  const templateNames = new Map<string, string>(templates.map((t) => [t.key, t.name]));
  for (const r of library) if (!templateNames.has(r.template_key)) templateNames.set(r.template_key, r.template_name);

  return (
    <div className="space-y-4">
      <section className={panel}>
        <h2 className="font-semibold">Library</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <input
            aria-label="Search library"
            className="field w-full"
            placeholder="Search saved prompts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            aria-label="Filter library by client"
            className="field w-full"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter library by template"
            className="field w-full"
            value={templateKey}
            onChange={(e) => setTemplateKey(e.target.value)}
          >
            <option value="">All templates</option>
            {[...templateNames.entries()].map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 min-h-11 text-sm">
          <input type="checkbox" checked={favorites} onChange={(e) => setFavorites(e.target.checked)} />
          Favorites only
        </label>
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>
      {library.map((r) => {
        const mine = !r.created_by || r.created_by === myId;
        return (
          <section key={r.id} className={panel}>
            <h3 className="font-semibold">{r.title || r.template_name}</h3>
            <p className="text-sm text-muted-foreground">
              {clients.find((c) => c.id === r.client_id)?.name || "No active client"} · {r.template_name} ·{" "}
              {new Date(r.created_at).toLocaleDateString()}
            </p>
            <div className="flex flex-wrap gap-2">
              <button className="studio-button" onClick={() => copy(r.prompt)}>
                Copy prompt
              </button>
              {r.ai_result && (
                <button className="studio-button" onClick={() => copy(r.ai_result!)}>
                  Copy answer
                </button>
              )}
              <button
                className="studio-button"
                disabled={busy}
                aria-pressed={r.is_favorite}
                onClick={() =>
                  run(
                    () => actions.toggleFavorite(r.id),
                    (favorite) =>
                      setLibrary((s) => s.map((item) => (item.id === r.id ? { ...item, is_favorite: favorite } : item))),
                  )
                }
              >
                {r.is_favorite ? "★ Favorite" : "☆ Favorite"}
              </button>
              <button className="studio-button" onClick={() => onOpen(r)}>
                Open in Create
              </button>
              {(mine || canManage) && (
                <button className="studio-button" disabled={busy} onClick={() => setDeleting(r.id)}>
                  Delete
                </button>
              )}
            </div>
          </section>
        );
      })}
      {!library.length && !loading && (
        <EmptyState title="No saved prompts" body="Save a prompt from Create, or change your filters to find one." />
      )}
      {more && library.length > 0 && (
        <button
          className="studio-button w-full"
          disabled={loading}
          onClick={() => load(library[library.length - 1].created_at)}
        >
          {loading ? "Loading…" : "Show older prompts"}
        </button>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete saved prompt?"
          body="This removes it from the Library for everyone."
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting;
            setDeleting(null);
            void run(
              () => actions.deleteLibraryItem(id),
              () => setLibrary((s) => s.filter((r) => r.id !== id)),
              "Prompt deleted",
            );
          }}
        />
      )}
    </div>
  );
}
