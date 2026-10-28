"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Header from "@/components/layout/header";
import { useToast, ToastContainer } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { TEMPLATES, CATEGORIES } from "@/lib/prompt-studio/templates";
import {
  CLIENT_CARD_FIELDS,
  CARD_PREFILL_FROM_CLIENT,
} from "@/lib/prompt-studio/client-card";
import {
  renderPrompt,
  renderClientCard,
  missingRequired,
  estimateTokens,
  placeholdersIn,
} from "@/lib/prompt-studio/render";
import type {
  StudioClient,
  SavedCard,
  CustomTemplate,
  LibraryItem,
  PromptTemplate,
  PromptField,
  ClientCard,
  CategoryId,
  ActionResult,
} from "@/lib/prompt-studio/types";
import * as actions from "./actions";
import { StudioFields, GrowingTextarea } from "./studio-fields";
import { SkillsTab } from "./skills-tab";
import { NotInstalled } from "./_not-installed";

const tabs = [
  "Create",
  "Client Cards",
  "My Templates",
  "Library",
  "Skills",
] as const;
const panel =
  "bg-card border border-border rounded-xl p-4 sm:p-6 space-y-4 min-w-0";
const blank = (): CustomTemplate => ({
  id: "",
  key: "",
  name: "",
  category: "ad",
  purpose: "",
  useIn: "",
  usesClientCard: true,
  fields: [],
  body: "",
});

export default function PromptStudioClient({
  clients,
  initialCards,
  initialTemplates,
  initialLibrary,
  installed,
  canManage,
  aiEnabled,
}: {
  clients: StudioClient[];
  initialCards: SavedCard[];
  initialTemplates: CustomTemplate[];
  initialLibrary: LibraryItem[];
  installed: boolean;
  canManage: boolean;
  aiEnabled: boolean;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<(typeof tabs)[number]>("Create");
  const [cards, setCards] = useState(initialCards);
  const [custom, setCustom] = useState(initialTemplates);
  const [library, setLibrary] = useState(initialLibrary);
  const [clientId, setClientId] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [category, setCategory] = useState("ad");
  const [templateKey, setTemplateKey] = useState(TEMPLATES[0].key);
  const [search, setSearch] = useState("");
  const [stars, setStars] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [ai, setAI] = useState<{ prompt: string; result: string } | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [cardClient, setCardClient] = useState("");
  const [cardDraft, setCardDraft] = useState<ClientCard>({});
  const [cardSearch, setCardSearch] = useState("");
  const [editor, setEditor] = useState<CustomTemplate | null>(null);
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [libSearch, setLibSearch] = useState("");
  const [libClient, setLibClient] = useState("");
  const [libTemplate, setLibTemplate] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    kind: "library" | "template";
    id: string;
  } | null>(null);
  const pending = useRef(false);
  const templates: PromptTemplate[] = [...TEMPLATES, ...custom];
  const template = templates.find((t) => t.key === templateKey) || TEMPLATES[0];
  const card = cards.find((c) => c.client_id === clientId);
  const prompt = renderPrompt(template, values, card?.card);
  const result = ai?.prompt === prompt ? ai.result : "";
  const missing = missingRequired(template, values);
  useEffect(() => {
    // Restore browser preferences after hydration; cancel if the page unmounts.
    const frame = requestAnimationFrame(() => {
      try {
        const saved = JSON.parse(localStorage.getItem("prompt-studio") || "{}");
        if (clients.some((c) => c.id === saved.clientId))
          setClientId(saved.clientId);
        if (
          [...CATEGORIES.map((c) => c.id), "custom", "favorites"].includes(
            saved.category,
          )
        )
          setCategory(saved.category);
        if (
          [...TEMPLATES, ...initialTemplates].some(
            (t) => t.key === saved.templateKey,
          )
        )
          setTemplateKey(saved.templateKey);
        if (Array.isArray(saved.stars))
          setStars(saved.stars.filter((s: unknown) => typeof s === "string"));
      } catch {
        /* Storage may be disabled. */
      }
      setReady(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [clients, initialTemplates]);
  useEffect(() => {
    if (ready) {
      try {
        localStorage.setItem(
          "prompt-studio",
          JSON.stringify({ clientId, category, templateKey, stars }),
        );
      } catch {
        /* Storage may be full or disabled. */
      }
    }
  }, [ready, clientId, category, templateKey, stars]);
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success("Copied — paste into Claude, ChatGPT or Gemini");
      } catch {
        toast.error("Could not copy. Select the text and copy it manually.");
      }
    },
    [toast],
  );
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        tab === "Create" &&
        (e.ctrlKey || e.metaKey) &&
        e.key === "Enter" &&
        missing.length === 0
      ) {
        e.preventDefault();
        void copy(prompt);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [tab, missing.length, copy, prompt]);
  async function run<T>(
    action: () => Promise<ActionResult<T>>,
    done: (data: T) => void,
    message?: string,
  ) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const r = await action();
      if (!r.ok) toast.error(r.error || "Please try again.");
      else {
        done(r.data as T);
        if (message) toast.success(message);
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function choose(t: PromptTemplate) {
    setTemplateKey(t.key);
    setValues({});
    setAI(null);
    setTitle("");
  }
  function openCard(id: string) {
    setCardClient(id);
    const saved = cards.find((c) => c.client_id === id);
    const client = clients.find((c) => c.id === id);
    setCardDraft(
      saved?.card ||
        Object.fromEntries(
          Object.entries(CARD_PREFILL_FROM_CLIENT).map(([k, v]) => [
            k,
            client?.[v] || "",
          ]),
        ),
    );
    setTab("Client Cards");
  }
  function editBody(body: string) {
    if (editor)
      setEditor({
        ...editor,
        body,
        fields: placeholdersIn(body).map(
          (key) =>
            editor.fields.find((f) => f.key === key) || {
              key,
              label: key.replace(/_/g, " "),
              type: "textarea",
            },
        ),
      });
  }
  function editField(key: string, patch: Partial<PromptField>) {
    if (editor)
      setEditor({
        ...editor,
        fields: editor.fields.map((f) =>
          f.key === key ? { ...f, ...patch } : f,
        ),
      });
  }
  const visibleTemplates = templates
    .filter(
      (t) =>
        (category === "custom"
          ? custom.some((c) => c.key === t.key)
          : category === "favorites"
            ? stars.includes(t.key)
            : t.category === category) &&
        `${t.name} ${t.purpose}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort(
      (a, b) => Number(stars.includes(b.key)) - Number(stars.includes(a.key)),
    );
  const visibleLibrary = library.filter(
    (r) =>
      (!libClient || r.client_id === libClient) &&
      (!libTemplate || r.template_key === libTemplate) &&
      (!favorites || r.is_favorite) &&
      `${r.title || ""} ${r.template_name} ${r.prompt}`
        .toLowerCase()
        .includes(libSearch.toLowerCase()),
  );
  return (
    <>
      <Header
        title="Prompt Studio"
        subtitle="Pick a client. Fill a few boxes. Make a better prompt."
      />
      <main className="prompt-studio mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
        <style>{`.prompt-studio .studio-button { min-height:44px; padding:10px 14px; border:1px solid var(--border); border-radius:8px; font-size:14px; font-weight:500; } .prompt-studio .studio-button:hover { background:var(--secondary); } .prompt-studio button:disabled { opacity:.45; cursor:not-allowed; } .prompt-studio .field { min-height:44px; } .prompt-studio .primary { background:var(--primary); color:var(--primary-foreground); }`}</style>
        {!installed && <NotInstalled />}
        <div
          className="flex flex-wrap gap-2"
          role="tablist"
          aria-label="Prompt Studio"
        >
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`studio-button ${tab === t ? "primary" : ""}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        {tab === "Create" && (
          <div className="space-y-5">
            <section className={panel}>
              <h2 className="font-semibold">1. Client</h2>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  className="field sm:w-64"
                  aria-label="Search clients"
                  placeholder="Search clients…"
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                />
                <select
                  className="field flex-1 min-w-0"
                  aria-label="Client"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                >
                  <option value="">No client</option>
                  {clients
                    .filter(
                      (c) =>
                        c.id === clientId ||
                        c.name
                          .toLowerCase()
                          .includes(clientSearch.toLowerCase()),
                    )
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
                {clientId &&
                  (card ? (
                    <span
                      tabIndex={0}
                      title={renderClientCard(card.card)}
                      className="rounded-full bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-300"
                    >
                      Card saved
                    </span>
                  ) : (
                    <button
                      className="studio-button text-amber-700 dark:text-amber-300"
                      onClick={() => openCard(clientId)}
                    >
                      No card yet · Add
                    </button>
                  ))}
              </div>
            </section>
            <section className={panel}>
              <h2 className="font-semibold">2. Template</h2>
              <div className="flex flex-wrap gap-2">
                {[
                  ...CATEGORIES,
                  { id: "custom", name: "My templates" },
                  { id: "favorites", name: "Favorites" },
                ].map((c) => (
                  <button
                    key={c.id}
                    className={`studio-button ${category === c.id ? "primary" : ""}`}
                    onClick={() => setCategory(c.id)}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
              <input
                className="field w-full"
                aria-label="Search templates"
                placeholder="Search templates by name or purpose…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visibleTemplates.map((t) => (
                  <div
                    key={t.key}
                    className={`flex rounded-xl border ${template.key === t.key ? "border-primary bg-primary/5" : "border-border"}`}
                  >
                    <button
                      className="flex-1 min-w-0 p-4 text-left"
                      onClick={() => choose(t)}
                      aria-pressed={template.key === t.key}
                    >
                      <span className="font-medium">{t.name}</span>
                      {custom.some((c) => c.key === t.key) && (
                        <span className="ml-2 rounded bg-secondary px-1.5 text-xs">
                          Custom
                        </span>
                      )}
                      <span className="mt-1 block text-sm text-muted-foreground">
                        {t.purpose}
                      </span>
                    </button>
                    <button
                      className="w-11 shrink-0 self-start py-3 text-xl"
                      aria-label={`${stars.includes(t.key) ? "Unstar" : "Star"} ${t.name}`}
                      aria-pressed={stars.includes(t.key)}
                      onClick={() =>
                        setStars((s) =>
                          s.includes(t.key)
                            ? s.filter((k) => k !== t.key)
                            : [...s, t.key],
                        )
                      }
                    >
                      {stars.includes(t.key) ? "★" : "☆"}
                    </button>
                  </div>
                ))}
              </div>
              {!visibleTemplates.length && (
                <EmptyState
                  title="No templates found"
                  body="Try a different search or category, or star templates to keep them in Favorites."
                  compact
                />
              )}
            </section>
            <div className="grid gap-5 lg:grid-cols-2 items-start">
              <section className={panel}>
                <h2 className="font-semibold">3. Fill · {template.name}</h2>
                <p className="text-sm text-muted-foreground">
                  Paste the answer into: {template.useIn}
                </p>
                <StudioFields
                  fields={template.fields}
                  values={values}
                  onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
                />
                {template.tip && (
                  <p className="text-sm text-muted-foreground">
                    {template.tip}
                  </p>
                )}
              </section>
              <section className={panel}>
                <div className="flex justify-between gap-2">
                  <h2 className="font-semibold">4. Result</h2>
                  <span className="text-xs text-muted-foreground">
                    ≈ {estimateTokens(prompt)} tokens
                  </span>
                </div>
                <textarea
                  aria-label="Prompt preview"
                  readOnly
                  value={prompt}
                  className="field w-full min-h-80 font-mono text-sm"
                />
                <button
                  className="studio-button primary w-full"
                  disabled={!!missing.length}
                  onClick={() => copy(prompt)}
                >
                  Copy prompt
                </button>
                {missing.length > 0 ? (
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    Fill in: {missing.join(", ")}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Ctrl/Cmd+Enter to copy
                  </p>
                )}
                {aiEnabled && (
                  <>
                    <button
                      className="studio-button"
                      disabled={busy || !!missing.length}
                      onClick={() =>
                        run(
                          () => actions.generateWithAI(prompt),
                          (data) => setAI({ prompt, result: data }),
                        )
                      }
                    >
                      {busy ? "Working…" : "Generate here"}
                    </button>
                    <p className="text-xs text-muted-foreground">
                      Free AI — check Malayalam wording before use.
                    </p>
                  </>
                )}
                {result && (
                  <>
                    <textarea
                      aria-label="AI result"
                      className="field w-full min-h-64 font-mono text-sm"
                      readOnly
                      value={result}
                    />
                    <button
                      className="studio-button"
                      onClick={() => copy(result)}
                    >
                      Copy AI result
                    </button>
                  </>
                )}
                {installed && (
                  <>
                    <input
                      className="field w-full"
                      aria-label="Library title"
                      placeholder="Title (optional)"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                    <button
                      className="studio-button"
                      disabled={busy || !!missing.length}
                      onClick={() =>
                        run(
                          () =>
                            actions.saveToLibrary({
                              client_id: clientId || null,
                              template_key: template.key,
                              template_name: template.name,
                              title: title || null,
                              inputs: values,
                              prompt,
                              ai_result: result || null,
                            }),
                          (data) =>
                            setLibrary((s) => [data, ...s].slice(0, 200)),
                          "Saved to Library",
                        )
                      }
                    >
                      Save to Library
                    </button>
                  </>
                )}
                <div className="flex flex-wrap gap-2">
                  {canManage && (
                    <button
                      className="studio-button"
                      onClick={() => {
                        setEditor({
                          ...template,
                          id: "",
                          key: "",
                          name: `${template.name} (copy)`,
                          based_on: template.key,
                        });
                        setSamples({});
                        setTab("My Templates");
                      }}
                    >
                      Duplicate as my template
                    </button>
                  )}
                  <button
                    className="studio-button"
                    onClick={() => {
                      setValues({});
                      setAI(null);
                      setTitle("");
                    }}
                  >
                    Clear
                  </button>
                </div>
              </section>
            </div>
          </div>
        )}
        {tab === "Client Cards" && (
          <div className="grid gap-5 lg:grid-cols-[1fr_2fr]">
            <section className={panel}>
              <h2 className="font-semibold">Client Cards</h2>
              <input
                aria-label="Search Client Cards"
                className="field w-full"
                placeholder="Search clients…"
                value={cardSearch}
                onChange={(e) => setCardSearch(e.target.value)}
              />
              {clients
                .filter((c) =>
                  c.name.toLowerCase().includes(cardSearch.toLowerCase()),
                )
                .map((c) => {
                  const saved = cards.find((s) => s.client_id === c.id);
                  return (
                    <button
                      key={c.id}
                      className={`studio-button block w-full text-left ${cardClient === c.id ? "border-primary" : ""}`}
                      onClick={() => openCard(c.id)}
                    >
                      <span className="block">{c.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {saved
                          ? `Card saved · updated ${new Date(saved.updated_at).toLocaleDateString()}`
                          : "No card"}
                      </span>
                    </button>
                  );
                })}
              {!clients.length && (
                <EmptyState
                  title="No active clients"
                  body="Add an active client to start a Client Card."
                  compact
                />
              )}
            </section>
            <section className={panel}>
              {cardClient ? (
                <>
                  <h2 className="font-semibold">
                    {clients.find((c) => c.id === cardClient)?.name}
                  </h2>
                  {!canManage && (
                    <p className="text-sm text-muted-foreground">
                      You can view this card. Ask a manager to update it.
                    </p>
                  )}
                  <StudioFields
                    fields={CLIENT_CARD_FIELDS}
                    values={cardDraft}
                    onChange={(k, v) => setCardDraft((s) => ({ ...s, [k]: v }))}
                    readOnly={!canManage}
                  />
                  <h3 className="font-medium">How it will appear</h3>
                  <pre className="whitespace-pre-wrap break-words rounded-lg bg-secondary p-4 text-sm">
                    {renderClientCard(cardDraft)}
                  </pre>
                  {installed && canManage && (
                    <button
                      className="studio-button primary"
                      disabled={busy || !cardDraft.brand?.trim()}
                      onClick={() =>
                        run(
                          () => actions.saveClientCard(cardClient, cardDraft),
                          (data) =>
                            setCards((s) => [
                              ...s.filter(
                                (c) => c.client_id !== data.client_id,
                              ),
                              data,
                            ]),
                          "Client Card saved",
                        )
                      }
                    >
                      Save Client Card
                    </button>
                  )}
                  <button
                    className="studio-button"
                    onClick={() => {
                      const t = TEMPLATES.find(
                        (t) => t.key === "fix-brief-to-card",
                      )!;
                      choose(t);
                      setCategory(t.category);
                      setClientId(cardClient);
                      setSearch("");
                      setTab("Create");
                    }}
                  >
                    Fill from a client message
                  </button>
                </>
              ) : (
                <EmptyState
                  title="Choose a client"
                  body="Save their details once and include them in every prompt."
                />
              )}
            </section>
          </div>
        )}
        {tab === "My Templates" && (
          <div className="grid gap-5 lg:grid-cols-[1fr_2fr]">
            <section className={panel}>
              <div className="flex flex-wrap justify-between gap-2">
                <h2 className="font-semibold">My Templates</h2>
                {canManage && (
                  <button
                    className="studio-button"
                    onClick={() => {
                      setEditor(blank());
                      setSamples({});
                    }}
                  >
                    New template
                  </button>
                )}
              </div>
              {custom.map((t) => (
                <button
                  className="studio-button w-full text-left"
                  key={t.id}
                  onClick={() => {
                    setEditor(t);
                    setSamples({});
                  }}
                >
                  {t.name}
                </button>
              ))}
              {!custom.length && (
                <EmptyState
                  title="No custom templates yet"
                  body="Duplicate a template from Create, or start a new one here."
                  compact
                />
              )}
            </section>
            <section className={panel}>
              {editor ? (
                <>
                  <h2 className="font-semibold">
                    {editor.id ? "Edit template" : "New template"}
                  </h2>
                  <fieldset disabled={!canManage} className="space-y-4">
                    <label className="block text-sm">
                      Name
                      <input
                        className="field w-full mt-1"
                        value={editor.name}
                        onChange={(e) =>
                          setEditor({ ...editor, name: e.target.value })
                        }
                      />
                    </label>
                    <label className="block text-sm">
                      Category
                      <select
                        className="field w-full mt-1"
                        value={editor.category}
                        onChange={(e) =>
                          setEditor({
                            ...editor,
                            category: e.target.value as CategoryId,
                          })
                        }
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-sm">
                      Purpose
                      <input
                        className="field w-full mt-1"
                        value={editor.purpose}
                        onChange={(e) =>
                          setEditor({ ...editor, purpose: e.target.value })
                        }
                      />
                    </label>
                    <label className="block text-sm">
                      Paste into
                      <input
                        className="field w-full mt-1"
                        value={editor.useIn}
                        onChange={(e) =>
                          setEditor({ ...editor, useIn: e.target.value })
                        }
                      />
                    </label>
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={editor.usesClientCard}
                        onChange={(e) =>
                          setEditor({
                            ...editor,
                            usesClientCard: e.target.checked,
                          })
                        }
                      />
                      Add client card
                    </label>
                    <label className="block text-sm space-y-1">
                      <span>Body · use {"{{placeholders}}"} for fields</span>
                      <GrowingTextarea
                        label="Template body"
                        value={editor.body}
                        onChange={editBody}
                      />
                    </label>
                    {editor.fields.map((f) => (
                      <div
                        key={f.key}
                        className="rounded-lg border border-border p-3 space-y-2"
                      >
                        <p className="text-xs font-mono">{`{{${f.key}}}`}</p>
                        <label className="block text-sm">
                          Label
                          <input
                            className="field w-full"
                            value={f.label}
                            onChange={(e) =>
                              editField(f.key, { label: e.target.value })
                            }
                          />
                        </label>
                        <label className="block text-sm">
                          Type
                          <select
                            className="field w-full"
                            value={f.type}
                            onChange={(e) =>
                              editField(f.key, {
                                type: e.target.value as PromptField["type"],
                              })
                            }
                          >
                            {["textarea", "text", "select", "number"].map(
                              (t) => (
                                <option key={t}>{t}</option>
                              ),
                            )}
                          </select>
                        </label>
                        {f.type === "select" && (
                          <label className="block text-sm">
                            Options (one per line)
                            <textarea
                              className="field w-full"
                              value={(f.options || []).join("\n")}
                              onChange={(e) =>
                                editField(f.key, {
                                  options: e.target.value.split("\n"),
                                })
                              }
                            />
                          </label>
                        )}
                        <label className="flex min-h-11 gap-2 items-center text-sm">
                          <input
                            type="checkbox"
                            checked={!!f.required}
                            onChange={(e) =>
                              editField(f.key, { required: e.target.checked })
                            }
                          />
                          Required
                        </label>
                      </div>
                    ))}
                  </fieldset>
                  <h3 className="font-medium">Try sample values</h3>
                  <StudioFields
                    fields={editor.fields}
                    values={samples}
                    onChange={(k, v) => setSamples((s) => ({ ...s, [k]: v }))}
                  />
                  <pre className="whitespace-pre-wrap break-words rounded-lg bg-secondary p-4 text-sm">
                    {renderPrompt(editor, samples, card?.card)}
                  </pre>
                  {installed && canManage && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="studio-button primary"
                        disabled={
                          busy || !editor.name.trim() || !editor.body.trim()
                        }
                        onClick={() =>
                          run(
                            () => actions.saveCustomTemplate(editor),
                            (data) => {
                              setCustom((s) => [
                                ...s.filter((t) => t.id !== data.id),
                                data,
                              ]);
                              setEditor(data);
                            },
                            "Template saved",
                          )
                        }
                      >
                        Save template
                      </button>
                      {editor.id && (
                        <button
                          className="studio-button"
                          disabled={busy}
                          onClick={() =>
                            setConfirmation({ kind: "template", id: editor.id })
                          }
                        >
                          Delete template
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <EmptyState
                  title="Make a template your own"
                  body="Choose a template to view it, or create one using placeholders for the details that change."
                />
              )}
            </section>
          </div>
        )}
        {tab === "Library" && (
          <div className="space-y-4">
            <section className={panel}>
              <h2 className="font-semibold">Library</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <input
                  aria-label="Search library"
                  className="field w-full"
                  placeholder="Search saved prompts…"
                  value={libSearch}
                  onChange={(e) => setLibSearch(e.target.value)}
                />
                <select
                  aria-label="Filter library by client"
                  className="field w-full"
                  value={libClient}
                  onChange={(e) => setLibClient(e.target.value)}
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
                  value={libTemplate}
                  onChange={(e) => setLibTemplate(e.target.value)}
                >
                  <option value="">All templates</option>
                  {[
                    ...new Map(
                      library.map((r) => [r.template_key, r.template_name]),
                    ).entries(),
                  ].map(([key, name]) => (
                    <option key={key} value={key}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 min-h-11 text-sm">
                <input
                  type="checkbox"
                  checked={favorites}
                  onChange={(e) => setFavorites(e.target.checked)}
                />
                Favorites only
              </label>
            </section>
            {visibleLibrary.map((r) => (
              <section key={r.id} className={panel}>
                <h3 className="font-semibold">{r.title || r.template_name}</h3>
                <p className="text-sm text-muted-foreground">
                  {clients.find((c) => c.id === r.client_id)?.name ||
                    "No active client"}{" "}
                  · {r.template_name} ·{" "}
                  {new Date(r.created_at).toLocaleDateString()}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="studio-button"
                    onClick={() => copy(r.prompt)}
                  >
                    Copy prompt
                  </button>
                  {r.ai_result && (
                    <button
                      className="studio-button"
                      onClick={() => copy(r.ai_result!)}
                    >
                      Copy AI result
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
                          setLibrary((s) =>
                            s.map((item) =>
                              item.id === r.id
                                ? { ...item, is_favorite: favorite }
                                : item,
                            ),
                          ),
                      )
                    }
                  >
                    {r.is_favorite ? "★ Favorite" : "☆ Favorite"}
                  </button>
                  <button
                    className="studio-button"
                    onClick={() => {
                      const t = templates.find((t) => t.key === r.template_key);
                      if (!t) {
                        toast.error(
                          "This template was deleted. You can still copy the saved prompt.",
                        );
                        return;
                      }
                      choose(t);
                      setCategory(t.category);
                      setClientId(
                        clients.some((c) => c.id === r.client_id)
                          ? r.client_id!
                          : "",
                      );
                      setValues(r.inputs);
                      setTitle(r.title || "");
                      setSearch("");
                      setTab("Create");
                    }}
                  >
                    Open in Create
                  </button>
                  <button
                    className="studio-button"
                    disabled={busy}
                    onClick={() =>
                      setConfirmation({ kind: "library", id: r.id })
                    }
                  >
                    Delete
                  </button>
                </div>
              </section>
            ))}
            {!visibleLibrary.length && (
              <EmptyState
                title="No saved prompts"
                body="Save a prompt from Create, or adjust your filters to find one."
              />
            )}
          </div>
        )}
        {tab === "Skills" && <SkillsTab copy={copy} error={toast.error} />}
      </main>
      {confirmation && (
        <ConfirmDialog
          title={
            confirmation.kind === "library"
              ? "Delete saved prompt?"
              : "Delete custom template?"
          }
          body="This removes the item from Prompt Studio. Built-in templates are kept."
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const item = confirmation;
            setConfirmation(null);
            if (item.kind === "library")
              void run(
                () => actions.deleteLibraryItem(item.id),
                () => setLibrary((s) => s.filter((r) => r.id !== item.id)),
                "Prompt deleted",
              );
            else
              void run(
                () => actions.deleteCustomTemplate(item.id),
                () => {
                  setCustom((s) => s.filter((t) => t.id !== item.id));
                  setEditor(null);
                },
                "Template deleted",
              );
          }}
        />
      )}
      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  );
}
