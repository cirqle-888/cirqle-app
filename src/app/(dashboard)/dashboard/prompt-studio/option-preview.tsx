"use client";
/**
 * Small pictures for Prompt Studio choices, drawn with CSS and SVG so they need
 * no image files and look the same offline. They are a rough guide to what each
 * option means — the AI tool makes the real thing.
 */
import { useId, type CSSProperties, type ReactNode } from "react";
import type { PreviewKind } from "@/lib/prompt-studio/types";

// ── Text effects ─────────────────────────────────────────────────────────────
const extrude = (c: string) =>
  `drop-shadow(1px 1px 0 ${c}) drop-shadow(1px 1px 0 ${c}) drop-shadow(1px 1px 0 ${c}) drop-shadow(2px 3px 3px rgba(0,0,0,.35))`;
const clip = (background: string): CSSProperties => ({
  background,
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  WebkitTextFillColor: "transparent",
  color: "transparent",
});
const LIGHT = "linear-gradient(135deg,#f8fafc,#e2e8f0)";
const GOLD =
  "linear-gradient(180deg,#fff6c2 0%,#f7c948 42%,#b7791f 55%,#ffe08a 100%)";

/** Effect name → [panel background, text style]. */
export const TEXT_EFFECTS: Record<string, [string, CSSProperties]> = {
  // Styles from the team's own flyers (Big Savings, More for Less, Fresh Basket …).
  "Bubble 3D with thick outline": [
    "linear-gradient(135deg,#fbe7ff,#e9d5ff)",
    {
      color: "#fff",
      WebkitTextStroke: "1.5px #7e22ce",
      textShadow:
        "0 2px 0 #c026d3,0 3px 0 #a21caf,0 4px 0 #86198f,0 5px 0 #701a75,0 7px 8px rgba(80,0,90,.45)",
      fontFamily: '"Arial Rounded MT Bold",ui-rounded,system-ui,sans-serif',
    },
  ],
  "Glossy two-colour on a shape": [
    "radial-gradient(ellipse at 50% 55%,#ec4899 0 45%,transparent 46%),linear-gradient(135deg,#fef3c7,#e0f2fe)",
    {
      ...clip("linear-gradient(180deg,#fff7ae 0%,#ffcf33 45%,#ff8a00 52%,#38bdf8 53%,#1d4ed8 100%)"),
      filter:
        "drop-shadow(1px 0 0 #fff) drop-shadow(-1px 0 0 #fff) drop-shadow(0 1px 0 #fff) drop-shadow(0 -1px 0 #fff) drop-shadow(2px 3px 0 #1e3a8a)",
    },
  ],
  "Cartoon sticker (white outline)": [
    "linear-gradient(135deg,#dcfce7,#fef9c3)",
    {
      ...clip("linear-gradient(180deg,#ef4444 0%,#dc2626 55%,#facc15 56%,#f59e0b 100%)"),
      filter:
        "drop-shadow(2px 0 0 #fff) drop-shadow(-2px 0 0 #fff) drop-shadow(0 2px 0 #fff) drop-shadow(0 -2px 0 #fff) drop-shadow(2px 3px 2px rgba(0,0,0,.35))",
    },
  ],
  "Gold and red festive 3D": [
    "radial-gradient(circle at 50% 40%,#dc2626,#7f1d1d)",
    { ...clip(GOLD), filter: extrude("#991b1b") },
  ],
  "Wooden sign board": [
    "repeating-linear-gradient(90deg,#8b5a2b 0 6px,#7a4b22 6px 9px,#9a6531 9px 15px)",
    {
      color: "#fff",
      textShadow: "0 2px 0 #d4d4d4,0 3px 0 #a3a3a3,0 5px 6px rgba(0,0,0,.5)",
    },
  ],
  "Food texture (cookie, chocolate)": [
    "linear-gradient(135deg,#fde7c8,#f8d3a4)",
    {
      ...clip(
        "radial-gradient(circle at 20% 30%,#6b3a1f 0 1.5px,transparent 2px),radial-gradient(circle at 70% 60%,#6b3a1f 0 1.5px,transparent 2px),radial-gradient(circle at 45% 80%,#6b3a1f 0 1.2px,transparent 2px),linear-gradient(180deg,#ffd27a 0%,#f59e0b 55%,#c2410c 100%)",
      ),
      filter: extrude("#7c2d12"),
    },
  ],
  "Water splash glossy": [
    "radial-gradient(circle at 50% 50%,#7dd3fc,#0369a1)",
    {
      color: "#fff",
      textShadow:
        "0 1px 0 #e0f2fe,0 2px 0 #bae6fd,0 3px 0 #7dd3fc,0 5px 8px rgba(3,40,90,.6)",
    },
  ],
  "Cloud white 3D": [
    "linear-gradient(180deg,#bfe3ff,#e8f4ff)",
    {
      color: "#fff",
      textShadow: "0 2px 0 #cbd5e1,0 3px 0 #94a3b8,0 6px 10px rgba(30,64,175,.35)",
    },
  ],
  "3D gold metallic": [LIGHT, { ...clip(GOLD), filter: extrude("#7a4a00") }],
  "Chrome silver": [
    LIGHT,
    {
      ...clip(
        "linear-gradient(180deg,#ffffff 0%,#cfd8e3 45%,#5b6573 52%,#e9eef5 100%)",
      ),
      filter: extrude("#3b4350"),
    },
  ],
  "Glossy candy plastic": [
    LIGHT,
    {
      ...clip("linear-gradient(180deg,#ffd1e3 0%,#ff4f93 40%,#e0005f 100%)"),
      filter: extrude("#9c0040"),
    },
  ],
  "Red and yellow sale 3D": [
    "linear-gradient(135deg,#fff7d6,#ffe7a3)",
    {
      color: "#ffd400",
      WebkitTextStroke: "1px #b00000",
      textShadow:
        "1px 1px 0 #d00000,2px 2px 0 #d00000,3px 3px 0 #b00000,4px 4px 0 #900000,6px 6px 6px rgba(0,0,0,.4)",
    },
  ],
  "Neon glow": [
    "#0b0b1a",
    {
      color: "#fff",
      textShadow:
        "0 0 3px #fff,0 0 8px #ff2bd6,0 0 16px #ff2bd6,0 0 26px #ff2bd6",
    },
  ],
  "Embossed (raised)": [
    "#d4d4d8",
    {
      color: "#d4d4d8",
      textShadow:
        "-1px -1px 0 #fff,1px 1px 0 #8b8b93,2px 2px 3px rgba(0,0,0,.3)",
    },
  ],
  "Balloon (inflated)": [
    LIGHT,
    {
      ...clip(
        "radial-gradient(circle at 35% 25%,#fff 0 7%,#ff8a8a 22%,#e03131 70%)",
      ),
      filter: extrude("#a61e1e"),
      fontFamily: '"Arial Rounded MT Bold",ui-rounded,system-ui,sans-serif',
    },
  ],
  "Frosted glass": [
    "linear-gradient(135deg,#4f8cc9,#7cc0ef)",
    {
      color: "rgba(255,255,255,.55)",
      WebkitTextStroke: "1px rgba(255,255,255,.95)",
      textShadow: "0 4px 10px rgba(0,40,90,.4)",
    },
  ],
  "Fire and flames": [
    "#1a0a05",
    {
      ...clip("linear-gradient(0deg,#ff2a00 0%,#ff8a00 45%,#ffe600 100%)"),
      filter: "drop-shadow(0 0 4px #ff5a00) drop-shadow(0 0 8px #ff2a00)",
    },
  ],
  Wooden: [
    LIGHT,
    {
      ...clip(
        "repeating-linear-gradient(100deg,#b07a45 0 3px,#8b5a2b 3px 6px,#c48a52 6px 9px)",
      ),
      filter: extrude("#5a3a1a"),
    },
  ],
  "Paper cut layers": [
    "#f1f5f9",
    {
      color: "#fff",
      textShadow:
        "2px 2px 0 #ffb703,4px 4px 0 #fb8500,6px 6px 0 #219ebc,8px 8px 6px rgba(0,0,0,.25)",
    },
  ],
  "Festive gold with lights": [
    "radial-gradient(circle at 12% 28%,#ffe9a8 0 2px,transparent 3px),radial-gradient(circle at 84% 22%,#ffe9a8 0 2px,transparent 3px),radial-gradient(circle at 72% 82%,#ffe9a8 0 2px,transparent 3px),radial-gradient(circle at 24% 80%,#ffe9a8 0 1.5px,transparent 2.5px),#4a0d0d",
    {
      ...clip(GOLD),
      filter: "drop-shadow(0 0 4px #ffd56b) drop-shadow(1px 2px 0 #7a4a00)",
    },
  ],
};

export const TEXT_FONTS: Record<string, CSSProperties> = {
  "Bold rounded": {
    fontFamily:
      '"Arial Rounded MT Bold","Nunito","Varela Round",ui-rounded,system-ui,sans-serif',
    fontWeight: 800,
  },
  "Heavy block": {
    fontFamily: '"Arial Black","Archivo Black",Impact,sans-serif',
    fontWeight: 900,
  },
  "Condensed tall": {
    fontFamily: 'Impact,"Oswald","Arial Narrow",sans-serif',
    fontWeight: 700,
    letterSpacing: "0.02em",
  },
  "Elegant serif": {
    fontFamily: 'Georgia,"Times New Roman",serif',
    fontWeight: 700,
  },
  "Brush script": {
    fontFamily: '"Brush Script MT","Segoe Script",cursive',
    fontStyle: "italic",
    fontWeight: 400,
  },
  Handwritten: {
    fontFamily: '"Marker Felt","Bradley Hand","Comic Sans MS",cursive',
    fontWeight: 700,
  },
};

export const TEXT_ANGLES: Record<string, string> = {
  "Straight front": "none",
  "Tilted back (perspective)": "perspective(80px) rotateX(34deg)",
  "Turned left": "perspective(80px) rotateY(38deg)",
  "Turned right": "perspective(80px) rotateY(-38deg)",
  "Slanted (italic)": "skewX(-14deg)",
  "Arched curve": "arch",
};

/** Text drawn in an effect, letter shape and angle. Used by the cards and the live preview. */
/** Split a headline into the chosen number of lines, keeping words whole. */
export function splitLines(text: string, layout?: string): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const n = layout?.startsWith("3") ? 3 : layout?.startsWith("2") || layout?.startsWith("One big") ? 2 : 1;
  if (n === 1 || words.length < 2) return [words.join(" ")];
  const per = Math.ceil(words.length / Math.min(n, words.length));
  const out: string[] = [];
  for (let i = 0; i < words.length; i += per) out.push(words.slice(i, i + per).join(" "));
  return out;
}

/** Text in an effect, letter shape and angle, on one or more lines. */
export function StyledText({
  text,
  effect,
  font,
  angle,
  size,
  lines,
}: {
  text: string;
  effect?: string;
  font?: string;
  angle?: string;
  size: number;
  lines?: string;
}) {
  const rows = splitLines(text, lines);
  if (rows.length > 1)
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", lineHeight: 1 }}>
        {rows.map((r, i) => (
          <OneLine
            key={i}
            text={r}
            effect={effect}
            font={font}
            angle={angle}
            size={lines?.startsWith("One big") && i > 0 ? size * 0.55 : size}
          />
        ))}
      </span>
    );
  return <OneLine text={text} effect={effect} font={font} angle={angle} size={size} />;
}

function OneLine({
  text,
  effect,
  font,
  angle,
  size,
}: {
  text: string;
  effect?: string;
  font?: string;
  angle?: string;
  size: number;
}) {
  const style: CSSProperties = {
    fontFamily: '"Arial Black",Impact,sans-serif',
    fontWeight: 900,
    fontSize: size,
    lineHeight: 1.1,
    whiteSpace: "nowrap",
    display: "inline-block",
    ...(effect ? TEXT_EFFECTS[effect]?.[1] : { color: "#111827" }),
    // The chosen letter shape wins over an effect's own font.
    ...(font ? TEXT_FONTS[font] : {}),
  };
  const transform = angle ? TEXT_ANGLES[angle] : undefined;
  if (transform === "arch") {
    const letters = [...text];
    const mid = (letters.length - 1) / 2;
    return (
      <span style={{ display: "inline-flex", alignItems: "flex-end" }}>
        {letters.map((ch, i) => {
          const off = i - mid;
          const deg = mid ? (off / mid) * 18 : 0;
          return (
            <span
              key={i}
              style={{
                ...style,
                transform: `translateY(${Math.abs(off) * Math.abs(off) * size * 0.04}px) rotate(${deg}deg)`,
              }}
            >
              {ch === " " ? " " : ch}
            </span>
          );
        })}
      </span>
    );
  }
  return <span style={{ ...style, transform }}>{text}</span>;
}

// ── Product photos ───────────────────────────────────────────────────────────
const BODY = "#3b82f6";
const SIDE = "#1d4ed8";
const CAP = "#f59e0b";

/** A simple bottle seen from the chosen angle, in a 64×64 box. */
function Bottle({ angle = "Straight front" }: { angle?: string }) {
  switch (angle) {
    case "Slight turn left":
    case "Slight turn right":
    case "Three-quarter left":
    case "Three-quarter right": {
      const left = angle.endsWith("left");
      // A slight turn shows a thin strip of the side; three-quarter shows more.
      const side = angle.startsWith("Slight") ? 4 : 8;
      return (
        <g>
          <polygon
            points={
              left
                ? `${24 - side},20 24,16 24,50 ${24 - side},54`
                : `${40 + side},20 40,16 40,50 ${40 + side},54`
            }
            fill={SIDE}
          />
          <rect x={left ? 24 : 18} y={16} width={22} height={34} rx={3} fill={BODY} />
          <rect x={left ? 24 : 18} y={26} width={22} height={11} fill="#fff" opacity={0.9} />
          <rect x={left ? 31 : 25} y={9} width={8} height={7} rx={1.5} fill={CAP} />
        </g>
      );
    }
    case "Slightly from above":
      return (
        <g>
          <rect x={20} y={20} width={24} height={34} rx={3} fill={BODY} />
          <ellipse cx={32} cy={20} rx={12} ry={5} fill={SIDE} />
          <ellipse cx={32} cy={18} rx={4} ry={2.5} fill={CAP} />
          <rect x={20} y={30} width={24} height={11} fill="#fff" opacity={0.9} />
        </g>
      );
    case "Top-down (flat lay)":
      return (
        <g>
          <rect x={14} y={14} width={36} height={36} rx={8} fill={BODY} />
          <circle cx={32} cy={32} r={8} fill={CAP} />
        </g>
      );
    case "Low hero angle":
      return (
        <g>
          <polygon points="22,16 42,16 48,56 16,56" fill={BODY} />
          <polygon points="20,30 44,30 45.5,40 18.5,40" fill="#fff" opacity={0.9} />
          <rect x={28.5} y={11} width={7} height={5} rx={1.5} fill={CAP} />
        </g>
      );
    default:
      return (
        <g>
          <rect x={20} y={16} width={24} height={36} rx={3} fill={BODY} />
          <rect x={20} y={27} width={24} height={12} fill="#fff" opacity={0.9} />
          <rect x={28} y={9} width={8} height={7} rx={1.5} fill={CAP} />
        </g>
      );
  }
}

const POSES: Record<string, { rotate: number; lift: number; lines?: boolean }> = {
  "Standing upright": { rotate: 0, lift: 0 },
  "Tilted a little": { rotate: 12, lift: 0 },
  "Falling diagonally": { rotate: 35, lift: 4, lines: true },
  "Floating mid-air": { rotate: 0, lift: 8 },
  "Lying flat": { rotate: 90, lift: -6 },
};

function PhotoSvg({
  angle,
  pose,
  shadow,
}: {
  angle?: string;
  pose?: string;
  shadow?: string;
}) {
  const id = useId().replace(/:/g, "");
  const p = POSES[pose || ""] || POSES["Standing upright"];
  const bottle = (
    <g transform={`translate(0 ${-p.lift}) rotate(${p.rotate} 32 34)`}>
      <Bottle angle={angle} />
    </g>
  );
  const soft = shadow === "Soft shadow underneath" || shadow === "Shadow and reflection";
  const reflect = shadow === "Reflection below" || shadow === "Shadow and reflection";
  return (
    <svg viewBox="0 0 64 72" className="h-full w-full" aria-hidden>
      <defs>
        <filter id={`b${id}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2" />
        </filter>
        <linearGradient id={`f${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`m${id}`}>
          <rect x="0" y="54" width="64" height="18" fill={`url(#f${id})`} />
        </mask>
      </defs>
      {soft && (
        <ellipse cx={32} cy={56} rx={p.lift > 4 ? 10 : 15} ry={2.5} fill="#000" opacity={0.3} filter={`url(#b${id})`} />
      )}
      {shadow === "Drop shadow to the side" && (
        <g opacity={0.3} filter={`url(#b${id})`} transform="translate(7 5)">
          <g transform={`translate(0 ${-p.lift}) rotate(${p.rotate} 32 34)`}>
            <rect x={20} y={14} width={24} height={38} rx={3} fill="#000" />
          </g>
        </g>
      )}
      {reflect && (
        <g mask={`url(#m${id})`}>
          <g transform="translate(0 112) scale(1 -1)" opacity={0.5}>
            {bottle}
          </g>
        </g>
      )}
      {bottle}
      {p.lines && (
        <g stroke="#94a3b8" strokeWidth={1.5} strokeLinecap="round">
          <line x1={6} y1={14} x2={14} y2={22} />
          <line x1={10} y1={8} x2={18} y2={16} />
        </g>
      )}
    </svg>
  );
}

/** Where each text space sits on a flyer page (34 × 48 mini page). */
const SPACES: Record<string, CSSProperties> = {
  "Wide banner (3:1)": { left: 3, top: 4, width: 28, height: 9 },
  "Wide (16:9)": { left: 3, top: 4, width: 28, height: 16 },
  "Square (1:1)": { left: 8, top: 4, width: 18, height: 18 },
  "Tall (4:5)": { left: 9, top: 4, width: 16, height: 20 },
  "Small corner badge": { left: 22, top: 3, width: 10, height: 8 },
  "Fit the coloured box in my layout": { left: 4, top: 5, width: 22, height: 13 },
};

/** Width / height of each text space, for the live preview. */
export const SPACE_RATIOS: Record<string, string> = {
  "Wide banner (3:1)": "3 / 1",
  "Wide (16:9)": "16 / 9",
  "Square (1:1)": "1 / 1",
  "Tall (4:5)": "4 / 5",
  "Small corner badge": "4 / 3",
  "Fit the coloured box in my layout": "16 / 9",
};

/** The picture for one option of a field with a `preview` kind. */
export function OptionPreview({
  kind,
  option,
}: {
  kind: PreviewKind;
  option: string;
}): ReactNode {
  if (kind === "text-effect")
    return (
      <Panel bg={TEXT_EFFECTS[option]?.[0]}>
        <StyledText text="SALE" effect={option} size={22} />
      </Panel>
    );
  if (kind === "text-font")
    return (
      <Panel>
        <StyledText text="Sale" font={option} effect="3D gold metallic" size={22} />
      </Panel>
    );
  if (kind === "text-space") {
    const box = SPACES[option];
    return (
      <Panel bg="linear-gradient(180deg,#f8fafc,#eef2f7)">
        <span
          className="relative block rounded-sm border border-slate-300 bg-white"
          style={{ width: 34, height: 48 }}
          aria-hidden
        >
          <span
            className="absolute flex items-center justify-center rounded-[2px]"
            style={{
              ...box,
              background: option.startsWith("Fit") ? "#ffffff" : "#f59e0b",
              outline: option.startsWith("Fit") ? "2px dashed #2563eb" : undefined,
            }}
          />
        </span>
      </Panel>
    );
  }
  if (kind === "text-lines")
    return (
      <Panel>
        <StyledText text="BIG SAVE DEALS" lines={option} font="Heavy block" size={option.startsWith("1") ? 13 : 14} />
      </Panel>
    );
  if (kind === "text-angle")
    return (
      <Panel>
        <StyledText text="SALE" angle={option} effect="Red and yellow sale 3D" size={20} />
      </Panel>
    );
  return (
    <Panel bg="linear-gradient(180deg,#f8fafc,#eef2f7)">
      <PhotoSvg
        angle={kind === "photo-angle" ? option : undefined}
        pose={kind === "photo-pose" ? option : undefined}
        shadow={kind === "photo-shadow" ? option : "Soft shadow underneath"}
      />
    </Panel>
  );
}

export { PhotoSvg };

function Panel({ bg, children }: { bg?: string; children: ReactNode }) {
  return (
    <span
      className="flex h-16 w-full items-center justify-center overflow-hidden rounded-lg"
      style={{ background: bg || LIGHT }}
    >
      {children}
    </span>
  );
}
