/**
 * Template Validator generalises the "`#layerName` contract" convention
 * common in retail/production Figma templates: a data-fill pipeline finds
 * the right layer by name (e.g. `#product`, `#price`, `#imageurl`) rather
 * than by index or position. A TemplateRule captures the set of `#tokens` a
 * template *family* must contain; validating a specific template frame
 * against a rule tells a designer whether it's safe to ship before a
 * data-fill job runs against it and silently no-ops on a missing layer.
 */

export interface TemplateRuleLayer {
  /** Bare token, without the leading '#' (e.g. "price1", not "#price1"). */
  name: string;
  /** Missing required layers are 'error' issues; missing optional layers are 'warning'. */
  required: boolean;
  /** Optional free-text note shown in the rule editor and folded into the validation issue's description. */
  hint?: string;
}

export interface TemplateRule {
  id: string;
  label: string;
  requiredLayers: TemplateRuleLayer[];
}

/**
 * Seed presets written to `clientStorage` the first time `listRules` runs
 * and finds nothing saved yet. These are starting points, not fixed
 * defaults — the rule editor lets a designer add/remove/rename freely, and
 * edits are persisted back over these seeds like any other saved rule.
 */
export const SEED_TEMPLATE_RULES: TemplateRule[] = [
  {
    id: 'seed_retail_offer_card',
    label: 'Retail Offer Card',
    requiredLayers: [
      { name: 'product', required: true, hint: 'Main product name/title text.' },
      { name: 'price', required: true, hint: 'Primary price text.' },
      { name: 'price1', required: false, hint: 'Secondary price variant (e.g. member price).' },
      { name: 'price2', required: false, hint: 'Tertiary price variant (e.g. was/now).' },
      { name: 'offer', required: false, hint: 'Offer headline, e.g. "2 FOR $5".' },
      { name: 'offertext', required: false, hint: 'Supporting offer legal/detail copy.' },
      { name: 'imageurl', required: true, hint: 'Product image placeholder — filled from a URL at data-fill time.' },
      { name: 'brand', required: false, hint: 'Brand/logo text or image.' },
      { name: 'sku', required: false, hint: 'SKU / item code text.' },
      { name: 'badge', required: false, hint: 'Promo badge (e.g. "NEW", "SALE").' },
      { name: 'discount', required: false, hint: 'Discount percentage or amount text.' },
    ],
  },
  {
    id: 'seed_simple_banner',
    label: 'Simple Promo Banner',
    requiredLayers: [
      { name: 'headline', required: true, hint: 'Primary banner headline.' },
      { name: 'subheadline', required: false, hint: 'Supporting line under the headline.' },
      { name: 'cta', required: true, hint: 'Call-to-action button text.' },
      { name: 'imageurl', required: true, hint: 'Background/hero image placeholder.' },
      { name: 'logo', required: false, hint: 'Brand logo image.' },
    ],
  },
];
