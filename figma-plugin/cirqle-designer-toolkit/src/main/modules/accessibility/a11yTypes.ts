/**
 * Structured result shapes for the Accessibility Checker. These are plain,
 * structured-clonable data — the main thread computes them from the live
 * Figma document and hands them to the UI, which does all rendering
 * (including PDF generation, which needs a DOM jsPDF doesn't have access to
 * inside the Figma sandbox — see src/ui/lib/report/pdfReport.ts).
 */
import type { Issue } from '@shared/types';

export type WcagFindingLevel = 'fail' | 'AA' | 'AAA';

export interface ContrastSuggestion {
  /** Which side of the pair the suggested hex should be applied to. */
  field: 'text' | 'background';
  hex: string;
}

export interface ContrastFinding {
  /** Id of the TEXT node this finding is about. */
  nodeId: string;
  nodeName: string;
  textHex: string;
  backgroundHex: string;
  ratio: number;
  isLargeText: boolean;
  level: WcagFindingLevel;
  /** Only present when level === 'fail' and a fix could be found within the
   * iteration cap in a11yScan's suggestFix(). */
  suggestion?: ContrastSuggestion;
}

export interface FontSizeFinding {
  nodeId: string;
  nodeName: string;
  fontSize: number;
  minSize: number;
}

export interface TouchTargetFinding {
  nodeId: string;
  nodeName: string;
  width: number;
  height: number;
  minSize: number;
}

/** One distinct solid colour found in the scanned scope, plus how it would
 * look under each simulated colour-vision deficiency. All four CVD hexes are
 * a simulation of the colour VALUE only — not a render filter over Figma's
 * actual canvas (the Plugin API has no pixel/render access). */
export interface CvdSwatch {
  hex: string;
  protanopia: string;
  deuteranopia: string;
  tritanopia: string;
  achromatopsia: string;
}

export interface A11yScanResult {
  /** Composite 0-100 score. See computeScore() in a11yScan.ts for the exact
   * weighting formula (contrast 50% / font-size 25% / touch-target 25%). */
  score: number;
  contrast: ContrastFinding[];
  fontSize: FontSizeFinding[];
  touchTargets: TouchTargetFinding[];
  swatches: CvdSwatch[];
  /** Flattened Issue list (contrast fails, font-size, touch-target, and
   * "couldn't determine contrast" notes) — this is what feeds a shared
   * cross-module issues view, if/when one exists; the UI page also renders
   * from the more specific arrays above for a nicer per-category layout. */
  issues: Issue[];
}
