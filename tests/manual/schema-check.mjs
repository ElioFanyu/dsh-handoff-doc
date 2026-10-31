// Verify the three host contracts a Config declaration must satisfy.
const { default: Schema } = await import('@deepseek-ai/schemastery')
const { Config, CONFIG_DEFAULTS, validateSettings } = await import('../../lib/index.js')

const ok = []
const bad = []

// 1. Standard Schema, synchronous.
try {
  const result = Config['~standard'].validate({ autoHandoffAtContextPercent: 40 })
  if (result && typeof result.then === 'function') bad.push('validate returned a Promise (must be sync)')
  else if (result?.value?.autoHandoffAtContextPercent !== 40) bad.push('validate did not accept a valid patch')
  else ok.push('~standard.validate is synchronous and accepts a patch')
} catch (e) { bad.push('~standard.validate threw: ' + e.message) }

// 2. Schemastery instance: meta + dict + toJSON.
if (!Config.dict) bad.push('Config.dict missing (settings page cannot project)')
else ok.push(`Config.dict has ${Object.keys(Config.dict).length} fields`)
try {
  /*
   * Schemastery's `toJSON()` returns the SHARED-DEFINITIONS form
   * (`{ uid, refs }`), not a flat JSON Schema. `dsh-settings` walks `schema.dict`
   * for field names and dereferences `refs` for each field's constraints, which
   * is why a plain object yields `status: "unsupported"` and this shape does not.
   * Asserting the real shape here is what makes this check meaningful.
   */
  const json = Config.toJSON()
  if (json === null || typeof json !== 'object') bad.push('toJSON() did not return an object')
  else if (json.refs === undefined) bad.push('toJSON() returned no shared definitions (refs)')
  else {
    const refCount = Object.keys(json.refs).length
    const rootRef = json.refs[String(json.uid)]
    if (rootRef?.type !== 'object') bad.push('the root definition is not an object schema')
    else ok.push(`toJSON() -> object root + ${refCount} shared definitions`)
  }
} catch (e) { bad.push('toJSON threw: ' + e.message) }

// Every field must carry a `meta` block, which the settings page reads.
const noMeta = Object.entries(Config.dict ?? {}).filter(([, field]) => field?.meta === undefined)
if (noMeta.length > 0) bad.push(`${noMeta.length} fields have no meta (no default/min/max shown)`)
else ok.push('every field exposes meta for the settings form')

// 3. Defaults come from the schema itself.
const fieldCount = Object.keys(Config.dict ?? {}).length
const defaultCount = Object.values(CONFIG_DEFAULTS).filter((v) => v !== undefined).length
if (defaultCount !== fieldCount) bad.push(`defaults ${defaultCount} != fields ${fieldCount}`)
else ok.push(`every one of the ${fieldCount} fields has a default`)

// 4. New document fields are present with the right defaults.
const expect = {
  handoffDir: 'docs/handoff',
  handoffProjectFolder: '',
  handoffDocMaxChars: 24000,
  archivePreviousHandoff: true,
  reusePreviousHandoff: true,
}
for (const [k, v] of Object.entries(expect)) {
  if (CONFIG_DEFAULTS[k] !== v) bad.push(`default ${k} = ${JSON.stringify(CONFIG_DEFAULTS[k])}, expected ${JSON.stringify(v)}`)
}
if (!bad.length) ok.push('the five document fields default as documented')

// 5. Cross-field validation still blocks the bad combination.
const blocked = validateSettings({ ...CONFIG_DEFAULTS, autoHandoffEnabled: true, autoCompactEnabled: true, autoHandoffAtContextPercent: 70, autoCompactAtContextPercent: 70 })
if (blocked.blocking === undefined) bad.push('the compaction>=handoff rule no longer blocks')
else ok.push('the compaction/handoff ordering rule still blocks')

// 6. Rejection of an out-of-range value.
try {
  const rejected = Config['~standard'].validate({ autoHandoffAtContextPercent: 500 })
  if (rejected?.issues === undefined) bad.push('an out-of-range threshold was accepted')
  else ok.push('an out-of-range threshold is rejected')
} catch { ok.push('an out-of-range threshold throws') }

console.log('PASS')
for (const line of ok) console.log('  ✓ ' + line)
if (bad.length) {
  console.log('FAIL')
  for (const line of bad) console.log('  ✗ ' + line)
  process.exit(1)
}
