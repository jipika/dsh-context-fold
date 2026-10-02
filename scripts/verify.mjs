#!/usr/bin/env node
/**
 * Pre-publish gate for this plugin.
 *
 * It guards the specific failure that already shipped once: a DUPLICATED KEY in
 * cordis.patch.yml makes the host reject the overlay and skip the entire bundle
 * — silently. No tools, no nudge, no error anywhere in the UI. It just looks
 * like "this plugin does nothing".
 *
 *   node scripts/verify.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
const fail = (m) => { console.error('FAIL  ' + m); failed += 1 }
const ok = (m) => console.log('ok    ' + m)

// 1) the module must import cleanly and expose the plugin contract
try {
  // pathToFileURL is required: a bare Windows path (C:\...) is not a valid ESM
  // specifier, and this script has to run on macOS too.
  const mod = await import(pathToFileURL(join(root, 'index.js')).href + '?v=' + Date.now())
  if (typeof mod.name !== 'string' || mod.name.length === 0) fail('index.js must export a non-empty `name`')
  else ok('exports name = ' + mod.name)
  if (!Array.isArray(mod.inject)) fail('index.js must export `inject` as an array')
  else ok('exports inject = [' + mod.inject.join(', ') + ']')
  if (typeof mod.apply !== 'function') fail('index.js must export `apply(ctx, config)`')
  else ok('exports apply()')
} catch (error) {
  fail('index.js failed to import: ' + String((error && error.message) || error))
}

// 2) no duplicated mapping key at the same nesting level in the overlay
try {
  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const byIndent = new Map()
  let duplicate = null
  for (const raw of text.split('\n')) {
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue
    const m = raw.match(/^(\s*)(?:-\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*:/)
    if (m === null) continue
    const indent = m[1].length
    const key = m[2]
    for (const level of [...byIndent.keys()]) if (level > indent) byIndent.delete(level)
    const seen = byIndent.get(indent) || new Set()
    if (seen.has(key)) { duplicate = key + ' at indent ' + indent; break }
    seen.add(key)
    byIndent.set(indent, seen)
  }
  if (duplicate !== null) {
    fail('cordis.patch.yml repeats a key: ' + duplicate +
      '  <- the host would SKIP THE WHOLE BUNDLE, silently')
  } else {
    ok('cordis.patch.yml has no duplicated keys')
  }
} catch (error) {
  fail('cordis.patch.yml unreadable: ' + String((error && error.message) || error))
}

// 3) no absolute platform paths baked into the source (this must run on macOS too)
try {
  const src = readFileSync(join(root, 'index.js'), 'utf8')
  const bad = src.match(/['"`](?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)/)
  if (bad !== null) fail('index.js contains a hardcoded absolute path: ' + bad[0])
  else ok('index.js has no hardcoded absolute paths')
} catch {
  /* reported by check 1 */
}

// 4) the published metadata must not be private
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (pkg.private === true) fail('package.json is marked private')
  else ok('package.json is publishable')
  if (!pkg.dsh || !pkg.dsh.bundle || !pkg.dsh.bundle.patch) fail('package.json is missing dsh.bundle.patch')
  else ok('package.json declares dsh.bundle.patch')
} catch (error) {
  fail('package.json unreadable: ' + String((error && error.message) || error))
}

console.log(failed === 0 ? '\nALL CHECKS PASSED' : '\n' + failed + ' CHECK(S) FAILED')
process.exit(failed === 0 ? 0 : 1)
