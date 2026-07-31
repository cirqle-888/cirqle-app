/**
 * PDF export for the Accessibility Checker. Runs entirely in the UI
 * (browser iframe) thread — jsPDF needs a DOM, which src/main/** does not
 * have (Figma's plugin sandbox). The main thread only ever hands back
 * structured scan data (see a11yTypes.ts); all rendering happens here.
 *
 * Kept deliberately simple: built-in Helvetica, no external images/fonts,
 * plain text + filled rectangles for the colour-blindness swatch grid.
 */
import { jsPDF } from 'jspdf';
import type { A11yScanResult, ContrastFinding, FontSizeFinding, TouchTargetFinding, CvdSwatch } from './a11yTypes';

const MARGIN = 14;
const PAGE_WIDTH = 210; // A4, mm
const PAGE_HEIGHT = 297;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

export function generateAccessibilityPdf(result: A11yScanResult, fileName: string): void {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  let y = MARGIN;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('Accessibility Scan Report', MARGIN, y);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`Generated ${new Date().toLocaleString()}`, MARGIN, y);
  doc.setTextColor(0);
  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(`Overall score: ${result.score} / 100`, MARGIN, y);
  y += 10;

  y = renderContrastSection(doc, result.contrast, y);
  y = renderFontSizeSection(doc, result.fontSize, y);
  y = renderTouchTargetSection(doc, result.touchTargets, y);
  renderSwatchSection(doc, result.swatches, y);

  doc.save(fileName);
}

function ensureSpace(doc: jsPDF, y: number, needed: number): number {
  if (y + needed > PAGE_HEIGHT - MARGIN) {
    doc.addPage();
    return MARGIN;
  }
  return y;
}

function sectionHeading(doc: jsPDF, title: string, y: number): number {
  const yy = ensureSpace(doc, y, 12);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(title, MARGIN, yy);
  doc.setFont('helvetica', 'normal');
  return yy + 6;
}

function renderContrastSection(doc: jsPDF, findings: ContrastFinding[], startY: number): number {
  let y = sectionHeading(doc, `Contrast findings (${findings.length})`, startY);

  if (findings.length === 0) {
    doc.setFontSize(9);
    doc.text('No text nodes with a resolvable solid fill were found in this scope.', MARGIN, y);
    return y + 8;
  }

  const colX = { node: MARGIN, ratio: MARGIN + 90, size: MARGIN + 115, level: MARGIN + 140, result: MARGIN + 165 };

  y = ensureSpace(doc, y, 6);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text('Node', colX.node, y);
  doc.text('Ratio', colX.ratio, y);
  doc.text('Size', colX.size, y);
  doc.text('Level', colX.level, y);
  doc.text('Result', colX.result, y);
  doc.setFont('helvetica', 'normal');
  y += 5;

  for (const f of findings) {
    y = ensureSpace(doc, y, 5);
    doc.setFontSize(8);
    doc.text(truncate(f.nodeName, 46), colX.node, y);
    doc.text(`${f.ratio.toFixed(2)}:1`, colX.ratio, y);
    doc.text(f.isLargeText ? 'Large' : 'Normal', colX.size, y);
    doc.text(f.level.toUpperCase(), colX.level, y);
    doc.setTextColor(f.level === 'fail' ? 200 : 30, f.level === 'fail' ? 40 : 130, 40);
    doc.text(f.level === 'fail' ? 'FAIL' : 'PASS', colX.result, y);
    doc.setTextColor(0);
    y += 5;
  }
  return y + 6;
}

function renderFontSizeSection(doc: jsPDF, findings: FontSizeFinding[], startY: number): number {
  let y = sectionHeading(doc, `Font size issues (${findings.length})`, startY);
  doc.setFontSize(9);
  if (findings.length === 0) {
    doc.text('No text below the minimum readable size was found.', MARGIN, y);
    return y + 8;
  }
  for (const f of findings) {
    y = ensureSpace(doc, y, 5);
    doc.text(`${truncate(f.nodeName, 60)} — ${f.fontSize}px (minimum ${f.minSize}px)`, MARGIN, y);
    y += 5;
  }
  return y + 6;
}

function renderTouchTargetSection(doc: jsPDF, findings: TouchTargetFinding[], startY: number): number {
  let y = sectionHeading(doc, `Touch target issues (${findings.length})`, startY);
  doc.setFontSize(9);
  if (findings.length === 0) {
    doc.text('No undersized interactive-looking nodes were found.', MARGIN, y);
    return y + 8;
  }
  for (const f of findings) {
    y = ensureSpace(doc, y, 5);
    doc.text(
      `${truncate(f.nodeName, 50)} — ${Math.round(f.width)}×${Math.round(f.height)}px (minimum ${f.minSize}px)`,
      MARGIN,
      y
    );
    y += 5;
  }
  return y + 6;
}

function renderSwatchSection(doc: jsPDF, swatches: CvdSwatch[], startY: number): void {
  let y = sectionHeading(doc, `Colour-blindness simulation (${swatches.length} colours)`, startY);

  doc.setFontSize(8);
  doc.setTextColor(110);
  doc.text(
    'Simulates colour VALUES only — this is not a live render filter over the actual canvas, since the Plugin API has no pixel/render access.',
    MARGIN,
    y,
    { maxWidth: CONTENT_WIDTH }
  );
  doc.setTextColor(0);
  y += 10;

  if (swatches.length === 0) {
    doc.setFontSize(9);
    doc.text('No solid colours were found in this scope.', MARGIN, y);
    return;
  }

  const swSize = 10;
  const gap = 6;
  const labels = ['Original', 'Protan.', 'Deuteran.', 'Tritan.', 'Achroma.'];

  for (const swatch of swatches) {
    y = ensureSpace(doc, y, swSize + 10);
    const hexes = [swatch.hex, swatch.protanopia, swatch.deuteranopia, swatch.tritanopia, swatch.achromatopsia];

    hexes.forEach((hex, i) => {
      const x = MARGIN + i * (swSize + gap);
      const { r, g, b } = hexToRgb(hex);
      doc.setDrawColor(200);
      doc.setFillColor(r, g, b);
      doc.rect(x, y, swSize, swSize, 'FD');
      doc.setFontSize(6);
      doc.setTextColor(90);
      doc.text(labels[i]!, x, y - 1.5);
      doc.text(hex, x, y + swSize + 3.5);
      doc.setTextColor(0);
    });

    y += swSize + 8;
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const value = parseInt(clean, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
