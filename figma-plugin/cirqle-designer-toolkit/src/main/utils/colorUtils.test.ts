import { describe, it, expect } from 'vitest';
import { contrastRatio, wcagLevel, isLargeText, rgbToHex, simulateColorBlindness } from './colorUtils';

describe('contrastRatio', () => {
  it('is 21 for black on white', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 0);
  });
  it('is 1 for identical colours', () => {
    expect(contrastRatio({ r: 128, g: 128, b: 128 }, { r: 128, g: 128, b: 128 })).toBeCloseTo(1, 5);
  });
  it('is symmetric', () => {
    const a = { r: 20, g: 90, b: 200 };
    const b = { r: 240, g: 240, b: 240 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });
});

describe('wcagLevel', () => {
  it('fails below 4.5:1 for normal text', () => {
    expect(wcagLevel(3, false)).toBe('fail');
  });
  it('passes AA at 4.5:1 for normal text', () => {
    expect(wcagLevel(4.5, false)).toBe('AA');
  });
  it('passes AAA at 7:1 for normal text', () => {
    expect(wcagLevel(7, false)).toBe('AAA');
  });
  it('large text only needs 3:1 for AA', () => {
    expect(wcagLevel(3, true)).toBe('AA');
  });
});

describe('isLargeText', () => {
  it('24px is large regardless of weight', () => {
    expect(isLargeText(24, 400)).toBe(true);
  });
  it('18.66px is only large when bold', () => {
    expect(isLargeText(18.66, 400)).toBe(false);
    expect(isLargeText(18.66, 700)).toBe(true);
  });
  it('16px normal weight is not large', () => {
    expect(isLargeText(16, 400)).toBe(false);
  });
});

describe('rgbToHex', () => {
  it('formats as uppercase 6-digit hex', () => {
    expect(rgbToHex({ r: 255, g: 0, b: 128 })).toBe('#FF0080');
  });
});

describe('simulateColorBlindness', () => {
  it('achromatopsia collapses to a single gray channel', () => {
    const result = simulateColorBlindness({ r: 200, g: 50, b: 50 }, 'achromatopsia');
    expect(result.r).toBe(result.g);
    expect(result.g).toBe(result.b);
  });
  it('pure gray is unaffected by any simulation type', () => {
    const gray = { r: 128, g: 128, b: 128 };
    for (const type of ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'] as const) {
      const result = simulateColorBlindness(gray, type);
      expect(Math.abs(result.r - 128)).toBeLessThanOrEqual(2);
      expect(Math.abs(result.g - 128)).toBeLessThanOrEqual(2);
      expect(Math.abs(result.b - 128)).toBeLessThanOrEqual(2);
    }
  });
});
