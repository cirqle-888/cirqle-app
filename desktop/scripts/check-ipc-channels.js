'use strict'

/**
 * Build gate: every IPC channel literal used anywhere in the desktop app
 * must exist in src/shared/ipc-channels.js, and every registry entry must
 * be used somewhere. The preloads are sandboxed and cannot require the
 * registry, so this static check is what keeps them from drifting.
 *
 * Run via `npm run check:ipc` (wired into pack/dmg).
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const registry = require(path.join(ROOT, 'src', 'shared', 'ipc-channels.js'))
const known = new Set(Object.values(registry))

const FILES = ['src/main.js', 'src/preload-cirqle.js', 'src/preload-ui.js']
const CALL_RE = /(?:ipcMain\.(?:on|handle)|ipcRenderer\.(?:send|invoke|on)|webContents\.send)\(\s*'([^']+)'/g

const used = new Set()
const unknown = []
for (const rel of FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  for (const m of src.matchAll(CALL_RE)) {
    used.add(m[1])
    if (!known.has(m[1])) unknown.push(`${rel}: '${m[1]}'`)
  }
}

// main.js consumes the registry via CH.<KEY> — count those as usage too
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
for (const m of mainSrc.matchAll(/\bCH\.([A-Z0-9_]+)\b/g)) {
  const val = registry[m[1]]
  if (val) used.add(val)
  else unknown.push(`src/main.js: CH.${m[1]} (no such registry key)`)
}

const unused = [...known].filter((c) => !used.has(c))

if (unknown.length) {
  console.error('IPC channels used but missing from src/shared/ipc-channels.js:')
  for (const u of unknown) console.error('  ' + u)
}
if (unused.length) {
  console.error('Registry channels no longer used anywhere: ' + unused.join(', '))
}
if (unknown.length || unused.length) process.exit(1)
console.log(`ipc-channels OK — ${known.size} channels, all registered and in use`)
