/**
 * UI-side mirror of src/main/modules/accessibility/a11yTypes.ts.
 *
 * Deliberately duplicated rather than imported: UI files must never import
 * from src/main/** (different runtime — the iframe has no `figma` global,
 * and src/main/** is bundled as a single sandbox IIFE with no DOM). This
 * mirrors the pattern already used for LogEntry in src/ui/pages/SettingsPage.tsx.
 * `Issue` itself lives in src/shared/types.ts, which both sides may import.
 */
import type { Issue } from '@shared/types';

export type WcagFindingLevel = 'fail' | 'AA' | 'AAA';

export interface ContrastSuggestion {
  field: 'text' | 'background';
  hex: string;
}

export interface ContrastFinding {
  nodeId: string;
  nodeName: string;
  textHex: string;
  backgroundHex: string;
  ratio: number;
  isLargeText: boolean;
  level: WcagFindingLevel;
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

export interface CvdSwatch {
  hex: string;
  protanopia: string;
  deuteranopia: string;
  tritanopia: string;
  achromatopsia: string;
}

export interface A11yScanResult {
  score: number;
  contrast: ContrastFinding[];
  fontSize: FontSizeFinding[];
  touchTargets: TouchTargetFinding[];
  swatches: CvdSwatch[];
  issues: Issue[];
}
