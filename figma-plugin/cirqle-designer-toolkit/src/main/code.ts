/**
 * Plugin main-thread entry point. Runs in Figma's sandbox: no DOM, no
 * fetch/network (manifest.networkAccess is "none"), and it's the only place
 * that can touch the document, selection, or figma.clientStorage. Its whole
 * job is: show the UI, register every module's handler, and dispatch
 * incoming requests to them (see bridge.ts).
 */
import { registerModule, startDispatcher, postEvent } from './bridge';
import type { ModuleId } from '@shared/types';

import { handle as renameHandle } from './modules/rename';
import { handle as cleanerHandle } from './modules/cleaner';
import { handle as accessibilityHandle } from './modules/accessibility';
import { handle as automatorHandle } from './modules/automator';
import { handle as templateValidatorHandle } from './modules/templateValidator';
import { handle as componentManagerHandle } from './modules/componentManager';
import { handle as assetManagerHandle } from './modules/assetManager';
import { handle as exportManagerHandle } from './modules/exportManager';
import { handle as analyticsHandle } from './modules/analytics';
import { handle as designQAHandle } from './modules/designQA';
import { handle as settingsHandle } from './modules/settings';
import { handle as systemHandle } from './modules/system';

const MODULE_HANDLERS: Record<ModuleId, typeof renameHandle> = {
  rename: renameHandle,
  cleaner: cleanerHandle,
  accessibility: accessibilityHandle,
  automator: automatorHandle,
  templateValidator: templateValidatorHandle,
  componentManager: componentManagerHandle,
  assetManager: assetManagerHandle,
  exportManager: exportManagerHandle,
  analytics: analyticsHandle,
  designQA: designQAHandle,
  settings: settingsHandle,
  system: systemHandle,
};

for (const [id, handler] of Object.entries(MODULE_HANDLERS)) {
  registerModule(id as ModuleId, handler);
}

figma.showUI(__html__, {
  width: 420,
  height: 640,
  themeColors: true,
});

startDispatcher();

// Menu commands (see manifest.json "menu") deep-link into a module by
// broadcasting an event the UI's router listens for on mount.
const COMMAND_TO_MODULE: Record<string, ModuleId | undefined> = {
  'open-rename': 'rename',
  'open-cleaner': 'cleaner',
  'open-accessibility': 'accessibility',
  'open-automator': 'automator',
  'open-template-validator': 'templateValidator',
  'open-analytics': 'analytics',
};

const targetModule = figma.command ? COMMAND_TO_MODULE[figma.command] : undefined;
if (targetModule) {
  // Give the UI a tick to mount before it can receive the event.
  setTimeout(() => postEvent('system', 'navigate', { module: targetModule }), 50);
}

// Keep the UI aware of selection changes without it having to poll —
// several modules (Rename, Automator "current selection" scope) want a
// live count.
figma.on('selectionchange', () => {
  postEvent('system', 'selectionchange', { count: figma.currentPage.selection.length });
});

figma.on('close', () => {
  // Nothing to persist here today — settings/history are written on every
  // change already — but this is the hook if that ever changes.
});
