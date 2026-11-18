"use client";
import { useMemo, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { cardFillPrompt, parseCardAnswer, styleStudyPrompt } from "@/lib/prompt-studio/card-fill";
import type { ClientCard } from "@/lib/prompt-studio/types";

/**
 * "Fill with AI": copy a master prompt for an AI that can browse, paste its
 * answer back, and the card's fields are filled for a person to check. Reading
 * the answer happens in the browser; nothing is saved until Save Client Card.
 */
export function CardFillPanel({
  clientName,
  card,
  showHelp,
  onCopy,
  onLinks,
  onFill,
}: {
  clientName: string;
  card: ClientCard;
  showHelp: boolean;
  onCopy: (text: string) => void;
  /** The page links box is the card's own "Page links" field. */
  onLinks: (links: string) => void;
  onFill: (values: Record<string, string>) => void;
}) {
  // A card with little on it opens ready to fill; a full one keeps this folded away.
  const [open, setOpen] = useState(() => Object.values(card).filter((v) => (v ?? "").trim()).length < 8);
  const [answer, setAnswer] = useState("");
  const [done, setDone] = useState<{ filled: string[]; refused: string[] } | null>(null);
  const parsed = useMemo(() => parseCardAnswer(answer), [answer]);
  const n = parsed.filled.length;
  const links = card.links ?? "";

  return (
    <div className="rounded-xl border border-border bg-secondary/40 p-3">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="inline-flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-500" /> Fill with AI
        </span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">Page links (Instagram, Facebook, website)</span>
            <input
              className="field w-full"
              value={links}
              placeholder="https://www.instagram.com/their_page/"
              onChange={(e) => onLinks(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="studio-button primary"
              title="Copies a prompt that asks an AI to research this client and fill every field"
              onClick={() => onCopy(cardFillPrompt({ name: clientName, links, card }))}
            >
              1. Copy master prompt
            </button>
            <button
              type="button"
              className="studio-button"
              title="Copies a shorter prompt: only how their existing posts look, sound and perform"
              onClick={() => onCopy(styleStudyPrompt({ name: clientName, links, card }))}
            >
              Style of existing posts only
            </button>
          </div>
          {showHelp && (
            <p className="text-xs text-muted-foreground">
              Paste the prompt into Claude, ChatGPT or Gemini with web search on, then paste the whole answer below.
              Lines the AI could not find stay as they are on the card.
            </p>
          )}
          <textarea
            aria-label="The AI's answer for this card"
            className="field w-full font-mono text-xs"
            style={{ minHeight: 96 }}
            placeholder="2. Paste the AI's answer here…"
            value={answer}
            onChange={(e) => {
              setAnswer(e.target.value);
              setDone(null);
            }}
          />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button
              type="button"
              className="studio-button primary"
              disabled={!n}
              onClick={() => {
                onFill(parsed.card);
                setDone({ filled: parsed.filled, refused: parsed.refused });
                setAnswer("");
              }}
            >
              {n ? `Fill ${n} field${n === 1 ? "" : "s"}` : "Fill the card"}
            </button>
            {answer.trim() && !n && (
              <span className="text-xs text-amber-700 dark:text-amber-300">
                No card lines found. The answer should look like &quot;Brand: …&quot;, one per line.
              </span>
            )}
          </div>
          {done && (
            <p className="text-xs text-muted-foreground" role="status">
              Filled: {done.filled.join(", ")}.
              {done.refused.length > 0 && ` Pick by hand: ${done.refused.join(", ")}.`} Check them, then press Save
              Client Card.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
