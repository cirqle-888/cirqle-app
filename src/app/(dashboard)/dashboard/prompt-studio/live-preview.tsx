"use client";
/**
 * A rough live picture of the choices on the Offer Flyer templates: the typed
 * text in the chosen effect, or the client's product photo turned, tilted and
 * shadowed the chosen way. It only helps people pick options — the AI tool
 * makes the real image.
 */
import type { CSSProperties } from "react";
import { PhotoSvg, SPACE_RATIOS, StyledText, TEXT_EFFECTS } from "./option-preview";
import { splitMulti } from "@/lib/prompt-studio/types";

/** A small stand-in for each object people can tick (only for the rough preview). */
const OBJECT_ICONS: Record<string, string> = {
  Confetti: "🎊",
  "Stars and sparkles": "✨",
  "Paint splashes": "🎨",
  Leaves: "🍃",
  "Fruits and vegetables": "🍅",
  "Water splash": "💦",
  "Shopping cart": "🛒",
  Megaphone: "📣",
  "Gift boxes": "🎁",
  Balloons: "🎈",
  "Smiley emoji faces": "😄",
  Trumpets: "🎺",
  "Diyas and lanterns": "🪔",
  Fireworks: "🎆",
  Clouds: "☁️",
  "Chain and lock": "🔒",
  "Cookies and snacks": "🍪",
};

const CHECKER: CSSProperties = {
  backgroundColor: "#fff",
  backgroundImage:
    "linear-gradient(45deg,#e5e7eb 25%,transparent 25%),linear-gradient(-45deg,#e5e7eb 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e5e7eb 75%),linear-gradient(-45deg,transparent 75%,#e5e7eb 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
};

function backdrop(background: string | undefined, effect?: string): CSSProperties {
  const b = (background || "").toLowerCase();
  if (b.startsWith("transparent")) return CHECKER;
  if (b.includes("white")) return { background: "#fff" };
  if (b.includes("green")) return { background: "#00ff00" };
  if (b.includes("black")) return { background: "#000" };
  return { background: (effect && TEXT_EFFECTS[effect]?.[0]) || "#f1f5f9" };
}

const RATIOS: Record<string, string> = {
  "Wide 16:9": "16 / 9",
  "Banner 3:1": "3 / 1",
  "Square 1:1": "1 / 1",
  "Portrait 4:5": "4 / 5",
};

const PHOTO_ANGLE: Record<string, string> = {
  "Slight turn left": "perspective(500px) rotateY(14deg)",
  "Slight turn right": "perspective(500px) rotateY(-14deg)",
  "Three-quarter left": "perspective(500px) rotateY(28deg)",
  "Three-quarter right": "perspective(500px) rotateY(-28deg)",
  "Slightly from above": "perspective(500px) rotateX(18deg)",
  "Top-down (flat lay)": "perspective(500px) rotateX(50deg)",
  "Low hero angle": "perspective(500px) rotateX(-16deg)",
};
const PHOTO_POSE: Record<string, string> = {
  "Tilted a little": "rotate(12deg)",
  "Falling diagonally": "rotate(32deg) translateY(-6%)",
  "Floating mid-air": "translateY(-10%)",
  "Lying flat": "rotate(90deg) scale(.8)",
};
const UNITS: Record<string, number> = {
  "2 side by side": 2,
  "3 grouped": 3,
  "Small stack": 3,
};

export function LivePreview({
  kind,
  values,
  image,
}: {
  kind: "text-effect" | "product-photo";
  values: Record<string, string>;
  /** The picture added on this computer, if any (product photo or flyer layout). */
  image?: string;
}) {
  if (kind === "text-effect") {
    const text = (values.text || "").trim() || "MEGA SALE";
    const objects = splitMulti(values.objects);
    const icons = objects.map((o) => OBJECT_ICONS[o]).filter(Boolean);
    const plate = objects.includes("Shape plate behind the text");
    const ribbon = objects.includes("Ribbon under the text") || !!values.subline?.trim();
    const rows = values.lines?.startsWith("3") ? 3 : values.lines?.startsWith("1") || !values.lines ? 1 : 2;
    const longest = Math.max(4, Math.ceil(text.length / rows));
    const layout = values.space === "Fit the coloured box in my layout";
    return (
      <Frame
        note={
          layout && image
            ? "Your layout is shown below the preview: the AI fills its coloured box. Rough guide only."
            : "Rough guide to the look and the space it fills — the AI tool makes the real lettering."
        }
      >
        <div
          className="relative mx-auto flex w-full items-center justify-center overflow-hidden rounded-lg p-3"
          style={{
            ...backdrop(values.background, values.effect),
            aspectRatio: SPACE_RATIOS[values.space] || RATIOS[values.ratio] || "16 / 9",
            maxHeight: 260,
            maxWidth: values.space === "Tall (4:5)" || values.space === "Square (1:1)" ? 260 : undefined,
          }}
        >
          {plate && (
            <span
              className="absolute inset-[14%] rounded-[40%] bg-gradient-to-br from-pink-500 to-purple-600 opacity-90"
              aria-hidden
            />
          )}
          <span className="relative flex flex-col items-center gap-1">
            <StyledText
              text={text}
              effect={values.effect}
              font={values.font}
              angle={values.angle}
              lines={values.lines}
              size={Math.max(18, Math.min(52, 300 / longest))}
            />
            {ribbon && (
              <span className="rounded-full bg-green-700 px-3 py-0.5 text-[11px] font-semibold text-white shadow">
                {values.subline?.trim() || "Offer valid on …"}
              </span>
            )}
          </span>
          {icons.slice(0, 6).map((icon, i) => (
            <span
              key={i}
              className="absolute text-xl"
              style={[
                { left: "4%", top: "8%" },
                { right: "4%", top: "8%" },
                { left: "6%", bottom: "8%" },
                { right: "6%", bottom: "8%" },
                { left: "45%", top: "2%" },
                { left: "45%", bottom: "2%" },
              ][i]}
              aria-hidden
            >
              {icon}
            </span>
          ))}
        </div>
        {layout && image && (
          // eslint-disable-next-line @next/next/no-img-element -- a local object URL
          <img src={image} alt="Your flyer layout" className="mx-auto max-h-48 rounded border border-border object-contain" />
        )}
      </Frame>
    );
  }
  const units = UNITS[values.units] || 1;
  const shadow = values.shadow || "";
  const softShadow =
    shadow === "Soft shadow underneath" || shadow === "Shadow and reflection";
  const reflect = shadow === "Reflection below" || shadow === "Shadow and reflection";
  const imgStyle: CSSProperties = {
    maxHeight: 150,
    maxWidth: `${80 / units}%`,
    objectFit: "contain",
    transform: [PHOTO_ANGLE[values.angle], PHOTO_POSE[values.pose]]
      .filter(Boolean)
      .join(" "),
    filter:
      shadow === "Drop shadow to the side"
        ? "drop-shadow(14px 12px 10px rgba(0,0,0,.35))"
        : undefined,
    WebkitBoxReflect: reflect
      ? "below 2px linear-gradient(transparent 55%, rgba(255,255,255,.4))"
      : undefined,
  } as CSSProperties;
  return (
    <Frame
      note={
        image
          ? "Your photo with the chosen angle, pose and shadow — a rough guide only."
          : "Add the product photo above to see it here. Rough guide only."
      }
    >
      <div
        className="relative flex h-56 w-full items-center justify-center overflow-hidden rounded-lg"
        style={backdrop(values.background)}
      >
        {image ? (
          <div className="flex items-end justify-center">
            {Array.from({ length: units }, (_, i) => (
              // eslint-disable-next-line @next/next/no-img-element -- a local object URL, never optimised
              <img key={i} src={image} alt="" style={{ ...imgStyle, marginLeft: i ? -18 : 0 }} />
            ))}
          </div>
        ) : (
          <div className="h-44 w-40">
            <PhotoSvg angle={values.angle} pose={values.pose} shadow={shadow} />
          </div>
        )}
        {image && softShadow && (
          <div
            className="pointer-events-none absolute bottom-6 left-1/2 h-4 w-1/3 -translate-x-1/2 rounded-full bg-black/30 blur-md"
            aria-hidden
          />
        )}
      </div>
    </Frame>
  );
}

function Frame({ note, children }: { note: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Preview</h3>
      {children}
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}
