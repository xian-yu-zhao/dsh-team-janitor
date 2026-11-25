#!/usr/bin/env node
/**
 * Zero-dependency smoke test for dsh-team-janitor.
 *
 * Runs the Host half against a fake Cordis context (fake `subagents`, `agents`,
 * `workspaceRegistry`, `tools`, `systemPrompt`) and asserts the observable
 * contract: which tools register, what their output shapes look like, that
 * output stays lossless JSON, and that closure/restore only touch the caller's
 * own subtree. Also asserts the packaging invariants (no @deepseek-ai imports,
 * bundle + web-client manifest present).
 *
 * Usage: node test/smoke.mjs   (npm test)
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, inject, name } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

let checks = 0
let failures = 0

function ok(condition, label, detail) {
  checks += 1
  if (condition) return
  failures += 1
  const suffix = detail === undefined ? '' : `\n    ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.error(`✗ ${label}${suffix}`)
}

function eq(actual, expected, label) {
  ok(Object.is(actual, expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Walks a value and returns the first path that would break lossless JSON. */
function jsonProblem(value, path = '$') {
  if (value === undefined) return `${path} is undefined`
  if (typeof value === 'function') return `${path} is a function`
  if (value === null) return undefined
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return undefined
  if (type !== 'object') return `${path} has type ${type}`
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const bad = jsonProblem(value[i], `${path}[${i}]`)
      if (bad) return bad
    }
    return undefined
  }
  for (const [key, item] of Object.entries(value)) {
    const bad = jsonProblem(item, `${path}.${key}`)
    if (bad) return bad
  }
  return undefined
}

function assertJsonLossless(value, label) {
  const bad = jsonProblem(value)
  ok(bad === undefined, `${label} stays lossless JSON`, bad)
  try {
    JSON.parse(JSON.stringify(value))
  } catch (error) {
    ok(false, `${label} JSON round-trips`, error instanceof Error ? error.message : String(error))
  }
}

/* ------------------------------------------------------------------ */
/* fake Host context                                                   */
/* ------------------------------------------------------------------ */

const ROOT_ID = 's-root'

function makeEntries() {
  return [
    { id: 's-a1', parentId: ROOT_ID, kind: 'agent', mode: 'continuable', path: 'a-1', label: 'auditor' },
    { id: 's-a2', parentId: 's-a1', kind: 'agent', mode: 'continuable', path: 'a-1/b-1' },
    { id: 's-a3', parentId: ROOT_ID, kind: 'agent', mode: 'continuable', path: 'a-3' },
    { id: 's-a5', parentId: 's-a1', kind: 'agent', mode: 'continuable', path: 'a-1/e-1' },
    { id: 's-a6', parentId: 's-a1', kind: 'agent', mode: 'oneshot', path: 'a-1/c-1' },
    { id: 's-d1', parentId: 's-a1', kind: 'diagnostic', path: 'a-1/diag', reason: 'session unavailable' },
  ]
}

/**
 * @param {object} [options]
 * @param {Record<string, {status: string}>} [options.agents] residency before archiving
 * @param {string[]} [options.archived] sessions already archived at start
 * @param {boolean} [options.keepResident] archiving leaves the member in the registry
 */
function makeContext({ agents = {}, archived = [], keepResident = false } = {}) {
  const entries = makeEntries()
  const agentMap = new Map(Object.entries(agents))
  const archivedIds = new Set(archived)
  const archiveCalls = []
  const unarchiveCalls = []
  const messages = []
  const promptContexts = []
  const handlers = new Map()
  const tools = new Map()

  const subagents = {
    rootOf: () => ({ id: ROOT_ID, name: 'lead' }),
    listDescendants: async () => entries,
    resolveName: async (_caller, reference) => {
      const byPath = entries.find((entry) => entry.path === reference || entry.id === reference)
      /* Mirrors the real service: an unmatched single token is returned as-is. */
      return byPath ? byPath.id : reference
    },
    sendMessage: async (_caller, targetId, content) => {
      messages.push({ targetId, content })
    },
  }

  const agentsService = {
    get: (id) => agentMap.get(id),
  }

  const workspaceRegistry = {
    archivedSessionIds: archivedIds,
    archiveSession: async (id, options) => {
      archiveCalls.push({ id, options })
      archivedIds.add(id)
      if (!keepResident) agentMap.delete(id)
    },
    unarchiveSession: async (id) => {
      unarchiveCalls.push(id)
      archivedIds.delete(id)
    },
  }

  const toolService = {
    register: (definition) => {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
    get: (toolName) => tools.get(toolName),
  }

  const systemPrompt = {
    getContextOrder: () => 60,
    context: (spec) => {
      promptContexts.push(spec)
      return () => {}
    },
  }

  const services = {
    subagents,
    agents: agentsService,
    workspaceRegistry,
    tools: toolService,
    systemPrompt,
  }

  const ctx = {
    get: (serviceName) => services[serviceName],
    effect: (run) => {
      const dispose = run()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: (event, handler) => {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    logger: { warn: () => {} },
  }

  return { ctx, tools, handlers, archiveCalls, unarchiveCalls, messages, promptContexts, archivedIds, agentMap, entries }
}

const caller = { id: 's-a1' }
const exec = (signal) => ({ agent: caller, signal })

/* ------------------------------------------------------------------ */
/* 1. registration                                                     */
/* ------------------------------------------------------------------ */

eq(name, 'team-janitor', 'plugin name')
ok(Array.isArray(inject) && inject.includes('tools'), 'inject lists the tools service')

const harness = makeContext({
  agents: {
    's-root': { status: 'running' },
    's-a1': { status: 'idle' },
    's-a2': { status: 'running' },
    's-a3': { status: 'idle' },
  },
  archived: ['s-a5'],
})
apply(harness.ctx)

const EXPECTED_TOOLS = ['team_close', 'team_overview', 'team_restore', 'team_sweep']
eq(harness.tools.size, EXPECTED_TOOLS.length, 'registers exactly four tools')
for (const toolName of EXPECTED_TOOLS) ok(harness.tools.has(toolName), `registers ${toolName}`)
for (const role of ['overview', 'close', 'sweep', 'restore']) {
  const definition = harness.tools.get(`team_${role}`)
  if (!definition) continue
  ok(typeof definition.execute === 'function', `team_${role} has execute`)
  ok(definition.parameters?.type === 'object', `team_${role} declares an object parameter schema`)
  ok(typeof definition.output?.render === 'function', `team_${role} declares a render`)
  ok(typeof definition.output?.schema === 'object', `team_${role} declares an output schema`)
}
ok(harness.tools.get('team_close')?.parameters?.required?.includes('agents'), 'team_close requires agents')
ok(harness.promptContexts.length === 1, 'registers one system-prompt context')

/* ------------------------------------------------------------------ */
/* 2. team_overview                                                    */
/* ------------------------------------------------------------------ */

const overviewTool = harness.tools.get('team_overview')

// Seed closing words through the public event the plugin listens to.
const onEnd = harness.handlers.get('subagent/end')
ok(typeof onEnd === 'function', 'listens to subagent/end')
onEnd?.({ id: 's-a1', lastAssistantMessage: [{ type: 'text', text: 'scan finished, 3 files changed' }] })
onEnd?.({ id: 's-a2', output: '' })

const overview = await overviewTool.execute({}, exec())
assertJsonLossless(overview, 'team_overview')
eq(overview.root, ROOT_ID, 'team_overview reports the tree root')
const rowByName = new Map(overview.rows.map((row) => [row.name, row]))
eq(rowByName.get('lead')?.status, 'running', 'root row reflects live status')
eq(rowByName.get('a-1')?.status, 'parked', 'idle member is parked')
eq(rowByName.get('a-1/b-1')?.status, 'running', 'running member is running')
eq(rowByName.get('a-1/e-1')?.status, 'closed', 'archived member is closed')
eq(rowByName.get('a-3')?.status, 'parked', 'sibling idle member is parked')
ok(rowByName.has('a-1/diag'), 'diagnostic entries surface as rows')
ok(rowByName.get('a-1')?.last === 'scan finished, 3 files changed', 'closing words come from subagent/end')
ok(rowByName.get('a-1/b-1')?.last === undefined, 'running members hide stale closing words')
ok(!rowByName.has('a-1/c-1'), 'one-shot children are not roster rows')

// Regression: a sibling is visible as a row but must never be offered as closable.
ok(!overview.closable.includes('a-3'), 'siblings are excluded from closable')
ok(!overview.closable.includes('a-1'), 'the caller is excluded from closable')
ok(!overview.closable.includes('a-1/e-1'), 'closed members are excluded from closable')

const compact = await overviewTool.execute({ lastWords: false }, exec())
assertJsonLossless(compact, 'team_overview(lastWords:false)')
ok(compact.rows.every((row) => row.last === undefined), 'lastWords:false drops closing words')
eq(compact.rows.length, overview.rows.length, 'lastWords:false keeps the same rows')

/* ------------------------------------------------------------------ */
/* 3. team_close                                                       */
/* ------------------------------------------------------------------ */

const closeTool = harness.tools.get('team_close')

const closedOne = await closeTool.execute({ agents: ['a-1/b-1'] }, exec())
assertJsonLossless(closedOne, 'team_close')
eq(closedOne.results.length, 1, 'team_close returns one row per reference')
eq(closedOne.results[0].outcome, 'closed', 'closing a descendant succeeds')
eq(closedOne.results[0].settled, true, 'settlement is observed as released')
ok(/archived/.test(closedOne.results[0].detail ?? ''), 'detail mentions archiving')
eq(harness.archiveCalls[0]?.options?.stopActivity, true, 'archiving stops activity')
ok(harness.archivedIds.has('s-a2'), 'archived set now contains the closed session')

const batch = await closeTool.execute({ agents: ['a-1/e-1', 'a-1/e-1', 'a-3', 'a-1'] }, exec())
assertJsonLossless(batch, 'team_close(batch)')
eq(batch.results[0].outcome, 'already-closed', 'first reference of a closed member reports already-closed')
eq(batch.results[1].outcome, 'duplicate', 'repeated reference is deduplicated')
eq(batch.results[2].outcome, 'refused', 'sibling close is refused')
eq(batch.results[3].outcome, 'refused', 'closing yourself is refused')

const selfClose = await closeTool.execute({ agents: ['a-1'] }, exec())
eq(selfClose.results[0].outcome, 'refused', 'closing the caller stays refused')

const typo = await closeTool.execute({ agents: ['explrerer'] }, exec())
eq(typo.results[0].outcome, 'unknown', 'an unmatched name is diagnosed as unknown, not as a foreign subtree')

// Settlement budget: when the member never leaves the registry the row says so.
const stubborn = makeContext({ agents: { 's-a2': { status: 'idle' } }, keepResident: true })
apply(stubborn.ctx)
const stuck = await stubborn.tools.get('team_close').execute({ agents: ['a-1/b-1'] }, { agent: caller })
eq(stuck.results[0].settled, false, 'still-resident member reports settled=false')
ok(/still resident/.test(stuck.results[0].detail ?? ''), 'still-resident detail explains the slot risk')

/* ------------------------------------------------------------------ */
/* 4. team_sweep                                                       */
/* ------------------------------------------------------------------ */

const sweepHarness = makeContext({ agents: { 's-a2': { status: 'running' }, 's-a3': { status: 'idle' } } })
apply(sweepHarness.ctx)
const sweepTool = sweepHarness.tools.get('team_sweep')

const sweepPreview = await sweepTool.execute({}, exec())
assertJsonLossless(sweepPreview, 'team_sweep(preview)')
eq(sweepPreview.preview, true, 'sweep previews by default')
eq(sweepPreview.closed, 0, 'preview closes nothing')
eq(sweepHarness.archiveCalls.length, 0, 'preview performs no archives')
ok(sweepPreview.candidates.every((row) => row.session !== 's-a2'), 'preview skips the running member')
ok(sweepPreview.candidates.some((row) => row.session === 's-a5'), 'preview lists the idle descendant')
ok(!sweepPreview.candidates.some((row) => row.session === 's-a3'), 'preview skips siblings')
ok(!sweepPreview.candidates.some((row) => row.session === 's-a6'), 'preview skips one-shot children')

const swept = await sweepTool.execute({ preview: false }, exec())
assertJsonLossless(swept, 'team_sweep(execute)')
eq(swept.preview, false, 'sweep executes with preview:false')
eq(swept.closed, sweepPreview.candidates.length, 'sweep closes every candidate')
eq(swept.closed, 1, 'only the idle descendant is closed')
eq(typeof swept.settled, 'number', 'sweep reports a settlement count')
eq(typeof swept.resident, 'number', 'sweep reports a resident count')
eq(swept.settled + swept.resident, swept.closed, 'settlement counts add up')
eq(swept.settled, 1, 'the closed member settled')
eq(swept.failures, 0, 'no sweep failures against a healthy registry')

const runningSweep = makeContext({ agents: { 's-a2': { status: 'running' } } })
apply(runningSweep.ctx)
const skipped = await runningSweep.tools.get('team_sweep').execute({}, { agent: caller })
ok(!skipped.candidates.some((row) => row.session === 's-a2'), 'running agents are skipped by default')
const included = await runningSweep.tools.get('team_sweep').execute({ includeRunning: true }, { agent: caller })
ok(included.candidates.some((row) => row.session === 's-a2'), 'includeRunning adds running agents')

/* ------------------------------------------------------------------ */
/* 5. team_restore                                                     */
/* ------------------------------------------------------------------ */

const restoreTool = harness.tools.get('team_restore')

const restored = await restoreTool.execute({ agents: ['a-1/e-1'] }, exec())
assertJsonLossless(restored, 'team_restore')
eq(restored.results[0].outcome, 'restored', 'restoring a closed member succeeds')
eq(harness.unarchiveCalls.at(-1), 's-a5', 'restore unarchives the session')
eq(harness.messages.length, 0, 'restore without prompt sends no message')

const resumed = await restoreTool.execute({ agents: ['a-1/e-1', 'a-1/e-1'], prompt: 'continue the scan' }, exec())
eq(resumed.results[0].outcome, 'not-closed', 'restoring an open member reports not-closed')
eq(resumed.results[1].outcome, 'duplicate', 'restore deduplicates repeated references')

await restoreTool.execute({ agents: ['a-1/e-1'], prompt: 'continue the scan' }, exec())
const withPrompt = await restoreTool.execute({ agents: ['a-1/e-1'], prompt: 'resume' }, exec())
eq(withPrompt.results[0].outcome, 'not-closed', 'restore is idempotent once open')

// Close then restore-and-continue in one sequence.
await closeTool.execute({ agents: ['a-1/e-1'] }, exec())
const resumedNow = await restoreTool.execute({ agents: ['a-1/e-1'], prompt: 'pick up where you left off' }, exec())
eq(resumedNow.results[0].outcome, 'restored', 'restore-and-continue restores a closed member')
const lastMessage = harness.messages.at(-1)
eq(lastMessage?.targetId, 's-a5', 'prompt is delivered to the restored session')
eq(lastMessage?.content?.[0]?.type, 'text', 'prompt is delivered as a text block')

const selfRestore = await restoreTool.execute({ agents: ['a-1'] }, exec())
eq(selfRestore.results[0].outcome, 'refused', 'restoring yourself is refused instead of throwing UNAUTHORIZED')

// A one-shot child can never take a prompt: refuse before touching the archive.
await closeTool.execute({ agents: ['a-1/c-1'] }, exec())
const promptOnOneShot = await restoreTool.execute({ agents: ['a-1/c-1'], prompt: 'continue' }, exec())
eq(promptOnOneShot.results[0].outcome, 'refused', 'prompt on a non-continuable member is refused')
ok(/not continuable/.test(promptOnOneShot.results[0].detail ?? ''), 'non-continuable refusal explains itself')

/* The hygiene nudge advertises only the tools that are actually visible. */
const hygiene = harness.promptContexts[0]?.text?.({ scope: undefined, toolSet: undefined })
ok(typeof hygiene === 'string' && hygiene.includes('team_close'), 'hygiene context mentions team_close')
ok(typeof hygiene === 'string' && hygiene.length < 260, 'hygiene context stays short')

/* ------------------------------------------------------------------ */
/* 6. packaging invariants                                             */
/* ------------------------------------------------------------------ */

const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
eq(pkg.type, 'module', 'package is ESM')
eq(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'bundle patch is declared')
eq(pkg.dsh?.client?.platform, 'web', 'browser half targets the web platform')
ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, 'browser half declares its client deps')
ok(pkg.files?.includes('lib/'), 'npm package ships lib/')
ok(pkg.files?.includes('client.js'), 'npm package ships client.js')
eq(pkg.exports?.['./client'], './client.js', 'package exports the client entry')

const vendorImport = /(?:from\s*|require\()\s*['"]@deepseek-ai\//
for (const file of ['lib/index.js', 'client.js']) {
  const source = await readFile(join(repo, file), 'utf8')
  ok(!vendorImport.test(source), `${file} imports no @deepseek-ai packages`)
}
const clientSource = await readFile(join(repo, 'client.js'), 'utf8')
ok(clientSource.includes('conversation.session.header.actions.subagent.footer'), 'client registers at the sanctioned slot')
ok(clientSource.includes('archivedSessionIds'), 'client reads the authoritative archived set')

/* ------------------------------------------------------------------ */

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks failed`)
  process.exit(1)
}
console.log(`✓ ${checks} checks passed`)
