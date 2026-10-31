"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Header from "@/components/layout/header";
import { copyToClipboard } from "@/lib/clipboard";
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
  withDefaults,
} from "@/lib/prompt-studio/render";
import { answerField, cardFromAnswer } from "@/lib/prompt-studio/answer";
import {
  STYLE_TEMPLATE_KEY,
  styleFromAnswer,
  styleTemplate,
  type SavedStyle,
} from "@/lib/prompt-studio/style";
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
import { FIELD_TYPES } from "@/lib/prompt-studio/types";
import * as actions from "./actions";
import { StudioFields, GrowingTextarea } from "./studio-fields";
import { SkillsTab } from "./skills-tab";
import { NotInstalled } from "./_not-installed";
import { LibraryTab } from "./library-tab";
import { LivePreview } from "./live-preview";

import { applyQuickLook, quickLookValues, type SavedQuickLook } from "@/lib/prompt-studio/quick-looks";

const LANGUAGES =
  CLIENT_CARD_FIELDS.find((f) => f.key === "language")?.options || [];

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
  category: "flyer",
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
  myId = null,
  initialStyles = [],
  initialQuickLooks = [],
}: {
  clients: StudioClient[];
  initialCards: SavedCard[];
  initialTemplates: CustomTemplate[];
  initialLibrary: LibraryItem[];
  installed: boolean;
  canManage: boolean;
  aiEnabled: boolean;
  myId?: string | null;
  initialStyles?: SavedStyle[];
  initialQuickLooks?: SavedQuickLook[];
}) {
  const toast = useToast();
  const [quickLooks, setQuickLooks] = useState(initialQuickLooks);
  const [lookName, setLookName] = useState("");
  const [deleteLookId, setDeleteLookId] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof tabs)[number]>("Create");
  const [cards, setCards] = useState(initialCards);
  const [custom, setCustom] = useState(initialTemplates);
  const [library, setLibrary] = useState(initialLibrary);
  const [clientId, setClientId] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [category, setCategory] = useState("flyer");
  const [templateKey, setTemplateKey] = useState(TEMPLATES[0].key);
  const [search, setSearch] = useState("");
  const [stars, setStars] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  /** The AI's answer: from "Generate here" or pasted back by the user. */
  const [answer, setAnswer] = useState("");
  /** Saved styles, and the one mixed into this prompt ("" = none). */
  const [styles, setStyles] = useState(initialStyles);
  const [styleId, setStyleId] = useState("");
  /** Overrides the card's language for this prompt ("" = use the card's). */
  const [language, setLanguage] = useState("");
  /** Local pictures (object URLs) per field; never uploaded. */
  const [attachments, setAttachments] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [cardClient, setCardClient] = useState("");
  const [cardDraft, setCardDraft] = useState<ClientCard>({});
  /** updated_at of the card as opened, so a save can't overwrite someone else's newer one. */
  const [cardBase, setCardBase] = useState<string | null>(null);
  const [cardSearch, setCardSearch] = useState("");
  const [editor, setEditor] = useState<CustomTemplate | null>(null);
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const pending = useRef(false);
  const templates: PromptTemplate[] = [...TEMPLATES, ...custom];
  const template = templates.find((t) => t.key === templateKey) || TEMPLATES[0];
  const card = cards.find((c) => c.client_id === clientId);
  const mixed = styles.find((x) => x.id === styleId);
  const prompt = renderPrompt(template, values, card?.card, {
    language,
    style: mixed?.recipe,
  });
  const shown = withDefaults(template, values);
  const missing = missingRequired(template, values);
  const receivers = templates.filter(
    (t) => t.key !== template.key && answerField(t),
  );
  // Local pictures are object URLs: free them when they are replaced or the page closes.
  const attachRef = useRef(attachments);
  useEffect(() => {
    attachRef.current = attachments;
  }, [attachments]);
  useEffect(
    () => () => Object.values(attachRef.current).forEach((u) => URL.revokeObjectURL(u)),
    [],
  );
  function attach(key: string, file: File | null) {
    setAttachments((s) => {
      if (s[key]) URL.revokeObjectURL(s[key]);
      const next = { ...s };
      if (file) next[key] = URL.createObjectURL(file);
      else delete next[key];
      return next;
    });
  }
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
        if (!(await copyToClipboard(text))) throw new Error("Clipboard unavailable");
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
    setAnswer("");
    setTitle("");
  }
  function openCard(id: string, fill?: ClientCard) {
    setCardClient(id);
    const saved = cards.find((c) => c.client_id === id);
    const client = clients.find((c) => c.id === id);
    setCardBase(saved?.updated_at ?? null);
    setCardDraft({
      ...(saved?.card ||
        Object.fromEntries(
          Object.entries(CARD_PREFILL_FROM_CLIENT).map(([k, v]) => [
            k,
            client?.[v] || "",
          ]),
        )),
      ...(fill || {}),
    });
    setTab("Client Cards");
  }
  /** Start another template with this answer already in its input box. */
  function sendAnswerTo(key: string) {
    const t = templates.find((x) => x.key === key);
    const field = t && answerField(t);
    if (!t || !field) return;
    const text = answer;
    choose(t);
    setCategory(custom.some((c) => c.key === t.key) ? "custom" : t.category);
    setSearch("");
    setValues({ [field]: text });
    toast.success(`Answer placed in “${t.fields.find((f) => f.key === field)?.label}”`);
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
                <select
                  className="field sm:w-56"
                  aria-label="Language for voice and text"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                >
                  <option value="">
                    {card?.card.language
                      ? `Language: ${card.card.language} (card)`
                      : "Language: not set"}
                  </option>
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      Language: {l}
                    </option>
                  ))}
                </select>
              </div>
              {template.usesClientCard && !card && (
                <p className="text-sm text-muted-foreground">
                  {clientId
                    ? "This client has no card yet, so the prompt goes without brand details."
                    : "No client picked, so the prompt goes without brand details."}
                  {!language && " Pick a language so voice and on-screen text come out right."}
                </p>
              )}
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
                  {template.direct
                    ? `Paste this prompt with the photo into: ${template.useIn}`
                    : `Paste the answer into: ${template.useIn}`}
                </p>
                {!!template.presets?.length && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">Quick looks</h3>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {template.presets.map((p) => (
                        <button
                          key={p.name}
                          className="studio-button text-left"
                          onClick={() =>
                            setValues((s) => {
                              // A Quick look replaces the last one's ticks instead of adding to them.
                              const next = { ...s };
                              for (const f of template.fields)
                                if (f.type === "toggle") next[f.key] = "";
                              return { ...next, ...p.values };
                            })
                          }
                        >
                          <span className="block font-medium">{p.name}</span>
                          {p.note && (
                            <span className="block text-xs text-muted-foreground">{p.note}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  {quickLooks.filter(p => p.template_key === template.key && (!p.client_id || p.client_id === clientId)).map(p => (
                    <div key={p.id} className="flex gap-2">
                      <button className="studio-button text-left flex-1" onClick={() => {
                        setValues(s => applyQuickLook(template, s, p.values));
                        setLanguage(p.language);
                        setStyleId(styles.some(s => s.id === p.style_id) ? p.style_id! : "");
                      }}>
                        <span className="block font-medium">{p.name}</span>
                        <span className="text-xs text-muted-foreground">{p.client_id ? "Client Quick look" : "Team Quick look"}</span>
                      </button>
                      {canManage && <button className="studio-button" disabled={busy} aria-label={`Delete ${p.name}`} onClick={() => setDeleteLookId(p.id)}>Delete</button>}
                    </div>
                  ))}
                  {canManage && installed && <div className="space-y-2 rounded-lg border border-border p-3">
                    <label className="block text-sm font-medium" htmlFor="quick-look-name">Save as a Quick look</label>
                    <div className="flex gap-2">
                      <input id="quick-look-name" className="field min-w-0 flex-1" maxLength={120} value={lookName} onChange={e => setLookName(e.target.value)} placeholder="Name this look" />
                      <button className="studio-button" disabled={busy || !lookName.trim()} onClick={() => run(
                        () => actions.saveQuickLook({ name: lookName, template_key: template.key, client_id: clientId || null, values: quickLookValues(template, values), style_id: styleId || null, language }),
                        p => { setQuickLooks(s => [...s, p]); setLookName(""); }, "Quick look saved",
                      )}>Save look</button>
                    </div>
                    <p className="text-xs text-muted-foreground">{clientId ? `For ${clients.find(c => c.id === clientId)?.name || "this client"}` : "For the whole team"}. Remembers choices, notes, style and language. Leaves out product names, headline text and pictures.</p>
                  </div>}
                </div>
                <StudioFields
                  fields={template.fields}
                  values={shown}
                  onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
                  attachments={attachments}
                  onAttach={attach}
                />
                {template.tip && (
                  <p className="text-sm text-muted-foreground">
                    {template.tip}
                  </p>
                )}
              </section>
              <section className={`${panel} lg:sticky lg:top-4`}>
                {template.livePreview && (
                  <LivePreview
                    kind={template.livePreview}
                    values={shown}
                    image={
                      template.livePreview === "product-photo"
                        ? attachments.product
                        : attachments.space
                    }
                  />
                )}
                <div className="flex justify-between gap-2">
                  <h2 className="font-semibold">4. Result</h2>
                  <span className="text-xs text-muted-foreground">
                    ≈ {estimateTokens(prompt)} tokens
                  </span>
                </div>
                {template.key !== STYLE_TEMPLATE_KEY && (
                  <label className="block space-y-1 text-sm">
                    <span className="font-medium">Mix in a saved style (optional)</span>
                    <select
                      className="field w-full"
                      aria-label="Mix in a saved style"
                      value={styleId}
                      onChange={(e) => setStyleId(e.target.value)}
                      disabled={!styles.length}
                    >
                      <option value="">
                        {styles.length
                          ? "No style"
                          : "No saved styles yet — make one with “Style from a picture”"}
                      </option>
                      {styles.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.title}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
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
                {template.direct && (
                  <p className="text-sm text-muted-foreground">
                    This prompt goes straight into the image tool: attach the
                    client’s photo there, paste, and send.
                  </p>
                )}
                {missing.length > 0 ? (
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    Fill in: {missing.join(", ")}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Ctrl/Cmd+Enter to copy
                  </p>
                )}
                {aiEnabled && !template.direct && (
                  <>
                    <button
                      className="studio-button"
                      disabled={busy || !!missing.length}
                      onClick={() =>
                        run(
                          () => actions.generateWithAI(prompt),
                          (data) => setAnswer(data),
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
                {!template.direct && (
                  <>
                <h3 className="text-sm font-medium">Answer</h3>
                <GrowingTextarea
                  label="Answer"
                  value={answer}
                  onChange={setAnswer}
                  placeholder={
                    aiEnabled
                      ? "Press Generate here, or paste the answer from Claude, ChatGPT or Gemini to save it or use it next."
                      : "Paste the answer from Claude, ChatGPT or Gemini here to save it or use it in the next template."
                  }
                />
                {answer.trim() && (
                  <div className="flex flex-wrap gap-2">
                    <button className="studio-button" onClick={() => copy(answer)}>
                      Copy answer
                    </button>
                    {template.key === STYLE_TEMPLATE_KEY && installed && (
                      <button
                        className="studio-button primary"
                        disabled={busy}
                        onClick={() => {
                          const { name, recipe } = styleFromAnswer(answer);
                          void run(
                            () =>
                              actions.saveToLibrary({
                                client_id: clientId || null,
                                template_key: template.key,
                                template_name: template.name,
                                title: (title.trim() || name).slice(0, 200),
                                inputs: values,
                                prompt,
                                ai_result: answer.trim(),
                              }),
                            (data) => {
                              setLibrary((s) => [data, ...s]);
                              setStyles((s) => [
                                { id: data.id, title: data.title || name, recipe },
                                ...s,
                              ]);
                            },
                            `Style “${title.trim() || name}” saved — pick it under “Mix in a saved style” in any template`,
                          );
                        }}
                      >
                        Save as a style
                      </button>
                    )}
                    {template.key === STYLE_TEMPLATE_KEY && installed && canManage && (
                      <button
                        className="studio-button"
                        disabled={busy}
                        onClick={() => {
                          const { name, recipe } = styleFromAnswer(answer);
                          void run(
                            () => actions.saveCustomTemplate(styleTemplate(title.trim() || name, recipe)),
                            (data) => {
                              setCustom((s) => [...s.filter((t) => t.id !== data.id), data]);
                              choose(data);
                              setCategory("custom");
                              setSearch("");
                            },
                            "Your text template is ready under My templates",
                          );
                        }}
                      >
                        Make a text template from it
                      </button>
                    )}
                    {template.key === "fix-brief-to-card" && clientId && (
                      <button
                        className="studio-button"
                        onClick={() => {
                          const parsed = cardFromAnswer(answer);
                          const n = Object.keys(parsed).length;
                          if (!n) {
                            toast.error("No card fields found in the answer.");
                            return;
                          }
                          openCard(clientId, parsed);
                          toast.success(`${n} card fields filled — check them and save.`);
                        }}
                      >
                        Fill Client Card from answer
                      </button>
                    )}
                    {receivers.length > 0 && (
                      <select
                        className="field min-w-0 flex-1"
                        aria-label="Use this answer in another template"
                        value=""
                        onChange={(e) => e.target.value && sendAnswerTo(e.target.value)}
                      >
                        <option value="">Use this answer in…</option>
                        {CATEGORIES.map((c) => {
                          const list = receivers.filter((t) => t.category === c.id && !custom.some((x) => x.key === t.key));
                          return list.length ? (
                            <optgroup key={c.id} label={c.name}>
                              {list.map((t) => (
                                <option key={t.key} value={t.key}>
                                  {t.name}
                                </option>
                              ))}
                            </optgroup>
                          ) : null;
                        })}
                        {receivers.some((t) => custom.some((x) => x.key === t.key)) && (
                          <optgroup label="My templates">
                            {receivers
                              .filter((t) => custom.some((x) => x.key === t.key))
                              .map((t) => (
                                <option key={t.key} value={t.key}>
                                  {t.name}
                                </option>
                              ))}
                          </optgroup>
                        )}
                      </select>
                    )}
                  </div>
                )}
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
                              ai_result: answer.trim() || null,
                            }),
                          (data) => setLibrary((s) => [data, ...s]),
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
                      setAnswer("");
                      setTitle("");
                      Object.values(attachments).forEach((u) => URL.revokeObjectURL(u));
                      setAttachments({});
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
                          () =>
                            actions.saveClientCard(cardClient, cardDraft, cardBase),
                          (data) => {
                            setCards((s) => [
                              ...s.filter(
                                (c) => c.client_id !== data.client_id,
                              ),
                              data,
                            ]);
                            setCardBase(data.updated_at);
                          },
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
                            {FIELD_TYPES.map((t) => (
                              <option key={t}>{t}</option>
                            ))}
                          </select>
                        </label>
                        {(f.type === "select" || f.type === "choice" || f.type === "multi") && (
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
                    {renderPrompt(editor, samples, card?.card, { language })}
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
                            setConfirmation(editor.id)
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
        <div hidden={tab !== "Library"}>
          <LibraryTab
            clients={clients}
            templates={templates}
            library={library}
            setLibrary={setLibrary}
            myId={myId}
            canManage={canManage}
            busy={busy}
            run={run}
            copy={copy}
            onOpen={(r) => {
              const t = templates.find((t) => t.key === r.template_key);
              if (!t) {
                toast.error(
                  "This template was deleted. You can still copy the saved prompt.",
                );
                return;
              }
              choose(t);
              setCategory(custom.some((c) => c.key === t.key) ? "custom" : t.category);
              setClientId(
                clients.some((c) => c.id === r.client_id) ? r.client_id! : "",
              );
              setValues(r.inputs);
              setAnswer(r.ai_result || "");
              setTitle(r.title || "");
              setSearch("");
              setTab("Create");
            }}
          />
        </div>
        {tab === "Skills" && <SkillsTab copy={copy} error={toast.error} />}
      </main>
      {deleteLookId && <ConfirmDialog title="Delete Quick look?" danger body="This removes the saved look for everyone on the team." confirmLabel="Delete" onCancel={() => setDeleteLookId(null)} onConfirm={() => {
        const id = deleteLookId;
        setDeleteLookId(null);
        void run(() => actions.deleteQuickLook(id), () => setQuickLooks(s => s.filter(p => p.id !== id)), "Quick look deleted");
      }} />}
      {confirmation && (
        <ConfirmDialog
          title="Delete custom template?"
          body="This removes the template from Prompt Studio. Built-in templates are kept."
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const id = confirmation;
            setConfirmation(null);
            void run(
              () => actions.deleteCustomTemplate(id),
              () => {
                setCustom((s) => s.filter((t) => t.id !== id));
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
