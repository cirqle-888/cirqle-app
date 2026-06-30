/**
 * Template Engine
 *
 * Maps a ReportTemplate name to its TemplateConfig — which sections
 * to include, which KPI to emphasise, and what the display name is.
 *
 * Adding a new template means adding one entry to TEMPLATE_CONFIGS.
 * No other file needs to change.
 */

import type { TemplateConfig, ReportTemplate } from './types'

const TEMPLATE_CONFIGS: Record<ReportTemplate, TemplateConfig> = {
  executive: {
    name: 'executive',
    displayName: 'Executive Summary',
    primaryKPI: 'roas',
    sections: {
      executiveSummary:     true,
      kpiScorecard:         true,
      dailyBreakdown:       false,
      campaignHealth:       true,
      benchmarkComparison:  true,
      forecast:             true,
      aiInsights:           true,
      budgetAnalysis:       true,
      recommendations:      true,
    },
  },

  marketing: {
    name: 'marketing',
    displayName: 'Marketing Performance',
    primaryKPI: 'reach',
    sections: {
      executiveSummary:     true,
      kpiScorecard:         true,
      dailyBreakdown:       true,
      campaignHealth:       true,
      benchmarkComparison:  true,
      forecast:             true,
      aiInsights:           true,
      budgetAnalysis:       false,
      recommendations:      true,
    },
  },

  lead_gen: {
    name: 'lead_gen',
    displayName: 'Lead Generation',
    primaryKPI: 'leads',
    sections: {
      executiveSummary:     true,
      kpiScorecard:         true,
      dailyBreakdown:       true,
      campaignHealth:       true,
      benchmarkComparison:  true,
      forecast:             true,
      aiInsights:           true,
      budgetAnalysis:       true,
      recommendations:      true,
    },
  },

  ecommerce: {
    name: 'ecommerce',
    displayName: 'E-commerce',
    primaryKPI: 'revenue',
    sections: {
      executiveSummary:     true,
      kpiScorecard:         true,
      dailyBreakdown:       true,
      campaignHealth:       true,
      benchmarkComparison:  true,
      forecast:             true,
      aiInsights:           true,
      budgetAnalysis:       true,
      recommendations:      true,
    },
  },

  performance: {
    name: 'performance',
    displayName: 'Performance Report',
    primaryKPI: 'roas',
    sections: {
      executiveSummary:     true,
      kpiScorecard:         true,
      dailyBreakdown:       true,
      campaignHealth:       true,
      benchmarkComparison:  true,
      forecast:             true,
      aiInsights:           true,
      budgetAnalysis:       true,
      recommendations:      true,
    },
  },

  agency: {
    name: 'agency',
    displayName: 'Agency Report',
    primaryKPI: 'spend',
    sections: {
      executiveSummary:     true,
      kpiScorecard:         true,
      dailyBreakdown:       true,
      campaignHealth:       true,
      benchmarkComparison:  true,
      forecast:             true,
      aiInsights:           true,
      budgetAnalysis:       true,
      recommendations:      true,
    },
  },

  /**
   * Daily — Matches the Cirqle Meta Ads Daily Report style:
   * campaign info header, KPI scorecard, last-3-days breakdown, budget status.
   * Omits AI-heavy sections (forecast, benchmarks, recommendations) to keep
   * the report fast and focused on today's numbers.
   */
  daily: {
    name: 'daily',
    displayName: 'Daily Report',
    primaryKPI: 'reach',
    sections: {
      executiveSummary:    false,
      kpiScorecard:        true,
      dailyBreakdown:      true,
      campaignHealth:      false,
      benchmarkComparison: false,
      forecast:            false,
      aiInsights:          false,
      budgetAnalysis:      true,
      recommendations:     false,
    },
  },
}

/**
 * Returns the TemplateConfig for the given template name.
 * Falls back to 'performance' for unknown values.
 */
export function resolveTemplate(template: ReportTemplate): TemplateConfig {
  return TEMPLATE_CONFIGS[template] ?? TEMPLATE_CONFIGS.performance
}

/** All available templates, for dropdowns / UI. */
export const ALL_TEMPLATES: TemplateConfig[] = Object.values(TEMPLATE_CONFIGS)
