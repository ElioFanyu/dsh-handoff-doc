/**
 * The plugin's own version, asserted from both places it is written down.
 *
 * `package.json` drives what the package manager installs and what the Plugins
 * page reports; `PLUGIN_VERSION` in `src/index.ts` is stamped into every
 * handoff document header by `versionOf()`. They are duplicated by necessity —
 * the host bundle cannot read its own `package.json` at runtime without
 * inventing a filesystem dependency — so they can drift, and drift is silent:
 * the document still renders, it just names the wrong tooling.
 *
 * The doc header is the one piece of provenance a future reader uses to decide
 * whether an old handoff was written by a version with a known defect, so a
 * wrong number there is worse than no number.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PLUGIN_VERSION, versionOf } from '../../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('plugin version', () => {
  it('keeps PLUGIN_VERSION equal to package.json', () => {
    expect(PLUGIN_VERSION).toBe(manifest.version)
  })

  it('looks like a release version', () => {
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('stamps the version into the document header', () => {
    expect(versionOf({})).toBe(`v${manifest.version}`)
  })

  it('appends the commit when one is known', () => {
    expect(versionOf({ git: { head: '9f3c1ab7deadbeef' } })).toBe(`v${manifest.version} · 9f3c1ab7`)
  })
})
