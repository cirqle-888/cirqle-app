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
export function StyledText({
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
    ...(font ? TEXT_FONTS[font] : {}),
    ...(effect ? TEXT_EFFECTS[effect]?.[1] : { color: "#111827" }),
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
    case "Three-quarter left":
    case "Three-quarter right": {
      const left = angle === "Three-quarter left";
      return (
        <g>
          <polygon
            points={left ? "16,20 24,16 24,50 16,54" : "48,20 40,16 40,50 48,54"}
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
