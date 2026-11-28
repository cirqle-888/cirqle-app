import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { SETTINGS_TABS, DEFAULT_SETTINGS_TAB, resolveSettingsTab, settingsTabParam } from './settings-tabs'

describe('resolveSettingsTab', () => {
  it.each(SETTINGS_TABS)('reopens %s from the ?tab= value the page writes', tab => {
    expect(resolveSettingsTab(settingsTabParam(tab))).toBe(tab)
  })

  // The three the server's old private list lacked: each one opened Company,
  // even after a refresh, and Requests → WhatsApp links to one of them.
  it.each([
    ['message-templates', 'Message Templates'],
    ['whatsapp-listener', 'WhatsApp Listener'],
    ['matching', 'Matching'],
  ] as const)('opens ?tab=%s on %s', (param, tab) => {
    expect(resolveSettingsTab(param)).toBe(tab)
  })

  it('takes a raw tab id in any case', () => {
    expect(resolveSettingsTab('Bank Accounts')).toBe('Bank Accounts')
    expect(resolveSettingsTab('PRIVACY & SECURITY')).toBe('Privacy & Security')
    expect(resolveSettingsTab('Groups & Params')).toBe('Groups & Params')
    expect(resolveSettingsTab('services')).toBe('Services')
  })

  it('opens Company for a missing or unknown tab', () => {
    expect(resolveSettingsTab(undefined)).toBe(DEFAULT_SETTINGS_TAB)
    expect(resolveSettingsTab(null)).toBe('Company')
    expect(resolveSettingsTab('')).toBe('Company')
    // Former tabs that became pages of their own.
    expect(resolveSettingsTab('clients')).toBe('Company')
    expect(resolveSettingsTab('pricing-matrix')).toBe('Company')
  })

  it('reads the first value of a repeated ?tab=', () => {
    expect(resolveSettingsTab(['tools', 'services'])).toBe('Tools')
    expect(resolveSettingsTab([])).toBe('Company')
  })
})

describe('settingsTabParam', () => {
  it('writes a URL-safe value', () => {
    expect(settingsTabParam('WhatsApp Listener')).toBe('whatsapp-listener')
    expect(settingsTabParam('Groups & Params')).toBe('groups-params')
    expect(settingsTabParam('Privacy & Security')).toBe('privacy-security')
  })

  it('gives every tab a value of its own', () => {
    const values = SETTINGS_TABS.map(settingsTabParam)
    expect(new Set(values).size).toBe(values.length)
  })
})

/**
 * Every `/dashboard/settings?tab=…` link in the app must name a real tab. One
 * pointed at `?tab=Clients` long after Clients left Settings, and an unknown
 * tab does not fail — it quietly opens Company.
 */
describe('links into Settings', () => {
  const SRC = join(process.cwd(), 'src')
  const sourceFiles = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) sourceFiles(full, out)
      // Tests hold fixtures, not links anyone can click.
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
    }
    return out
  }
  const links = sourceFiles(SRC).flatMap(file =>
    [...readFileSync(file, 'utf8').matchAll(/\/dashboard\/settings\?tab=([^&"'`$\s)]+)/g)]
      .map(m => ({ where: relative(SRC, file).split(sep).join('/'), tab: m[1] })))

  it('finds the links', () => {
    expect(links.length).toBeGreaterThan(0)
  })

  it('every ?tab= names a real tab', () => {
    const real = new Set(SETTINGS_TABS.map(settingsTabParam))
    const broken = links.filter(l => !real.has(settingsTabParam(decodeURIComponent(l.tab))))
    expect(broken.map(l => `${l.where}: ?tab=${l.tab}`)).toEqual([])
  })
})
