#!/usr/bin/env node
/**
 * Zero-dependency smoke test for dsh-team-janitor 2.0.0.
 *
 * Runs the Host half against a fake Cordis context (fake `subagents`, `agents`,
 * `workspaceRegistry`, `tools`, `systemPrompt`) and asserts the observable
 * contract: which tools register, how the result view projects each
 * `subagent/end` stop reason, when the roster must say `unknown`, the
 * step-time `when` gate, output that stays lossless JSON, subtree-scoped
 * close/restore, and the packaging invariants (no @deepseek-ai imports,
 * bundle + web-client manifest, model-facing declaration budget).
 *
 * Usage: node test/smoke.mjs   (npm test)
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, inject, name } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

/* Every case gets its own DSH_HOME under the OS temp directory: the real
   ~/.dsh/team-janitor/results.json is never touched, and one case cannot leak a
   persisted record into another. */
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'dsh-janitor-test-'))
let homeSeq = 0

/** Where the plugin will keep its results file for a given DSH home. */
function resultsFileFor(home) {
  return join(home, 'team-janitor', 'results.json')
}

/**
 * Activate the plugin the way the host does — `apply(ctx, config)` — with
 * DSH_HOME pointed at a throwaway directory, or at an explicit `dshHome` when
 * one case has to share storage across two plugin instances (a simulated
 * restart).
 */
function startPlugin(harness, { config, dshHome } = {}) {
  const home = dshHome ?? join(TEMP_ROOT, `home-${homeSeq += 1}`)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    apply(harness.ctx, config)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  harness.dshHome = home
  harness.resultsFile = resultsFileFor(home)
  return harness
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

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

/** Rendered text of one tool result (the only thing the model actually reads). */
function rendered(definition, value) {
  return definition.output.render({}, value).map((block) => block.text).join('\n')
}

/* ------------------------------------------------------------------ */
/* fake Host context                                                   */
/* ------------------------------------------------------------------ */

const ROOT_ID = 's-root'
const ROOT = { id: ROOT_ID, name: 'lead' }
const CALLER = { id: 's-a1' }
/** A member whose preset keeps the delegation tool. */
const DELEGATING = { id: 's-a3' }
/** A plain child: no delegation tool in its scope and no runtime ownership. */
const PLAIN = { id: 's-a8' }

/**
 * Catalog rows. `createdAt` is compared against the plugin's start instant:
 * an old row without a cached result must project to `unknown`, a row created
 * while the plugin was watching may project to `idle`.
 */
function makeEntries() {
  const old = Date.now() - 600000
  const fresh = Date.now() + 60000
  return [
    { id: 's-a1', parentId: ROOT_ID, kind: 'child', mode: 'continuable', path: 'a-1', label: 'auditor', createdAt: old, activity: 'inactive' },
    { id: 's-a2', parentId: 's-a1', kind: 'child', mode: 'continuable', path: 'a-1/b-1', createdAt: old, activity: 'running' },
    { id: 's-a3', parentId: ROOT_ID, kind: 'child', mode: 'continuable', path: 'a-3', createdAt: old, activity: 'inactive' },
    { id: 's-a5', parentId: 's-a1', kind: 'child', mode: 'continuable', path: 'a-1/e-1', createdAt: old, activity: 'inactive' },
    { id: 's-a6', parentId: 's-a1', kind: 'child', mode: 'oneshot', path: 'a-1/c-1', createdAt: old, activity: 'inactive' },
    { id: 's-a7', parentId: 's-a1', kind: 'child', mode: 'continuable', path: 'a-1/f-1', createdAt: old, activity: 'inactive' },
    { id: 's-a8', parentId: 's-a1', kind: 'child', mode: 'continuable', path: 'a-1/g-1', createdAt: old, activity: 'inactive' },
    { id: 's-a9', parentId: 's-a1', kind: 'child', mode: 'continuable', path: 'a-1/h-1', createdAt: fresh, activity: 'inactive' },
    { id: 's-d1', parentId: 's-a1', kind: 'diagnostic', path: 'a-1/diag', reason: 'session unavailable' },
  ]
}

/**
 * @param {object} [options]
 * @param {Record<string, {status: string}>} [options.agents] residency before archiving
 * @param {string[]} [options.archived] sessions already archived at start
 * @param {boolean} [options.keepResident] archiving leaves the member in the registry
 * @param {boolean} [options.withoutAgents] omit the agents service entirely
 * @param {string[]} [options.delegating] agent ids whose scope sees the delegation tool
 */
function makeContext({
  agents = {},
  archived = [],
  keepResident = false,
  withoutAgents = false,
  delegating = [ROOT_ID, 's-a1', 's-a3'],
} = {}) {
  const entries = makeEntries()
  const agentMap = new Map(Object.entries(agents))
  const archivedIds = new Set(archived)
  const archiveCalls = []
  const unarchiveCalls = []
  const messages = []
  const promptContexts = []
  const handlers = new Map()
  const tools = new Map()
  const warnings = []

  const subagents = {
    /* Mirrors the real service: only the live tree root resolves to itself. */
    rootOf: (caller) => {
      if (caller === undefined || typeof caller.id !== 'string') throw new Error('rootOf requires an agent')
      if (caller.id === ROOT_ID) return ROOT
      if (entries.some((entry) => entry.id === caller.id)) return ROOT
      throw new Error('agent has no active runtime owner')
    },
    listDescendants: async () => entries,
    resolveName: async (_caller, reference) => {
      /* Mirrors the real service: the tree root is reachable by its name. */
      if (reference === 'lead' || reference === ROOT_ID) return ROOT_ID
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
    register: (definition, options = {}) => {
      /* Test-only: dsh-tools keeps `when` beside the definition. The fake
         attaches it to the same object so that `tools.get(...) === definition`
         identity checks (used by the hygiene context) and direct gate
         evaluation in this file both behave like the real service. */
      definition.when = options.when
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
    /* Step admission: a supplied toolSet decides, exactly like dsh-tools. */
    get: (toolName, _scope, toolSet) => {
      const definition = tools.get(toolName)
      if (definition === undefined) return undefined
      if (toolSet === undefined) return definition
      return toolSet.has(toolName) ? definition : undefined
    },
    /* Visible definitions for a scope: drives the delegation-capability probe. */
    definitions: (scope) => {
      const visible = [...tools.values()]
      if (scope !== undefined && typeof scope.id === 'string' && !delegating.includes(scope.id)) return []
      return [...visible, { name: 'subagent' }, { name: 'list_agents' }]
    },
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
    workspaceRegistry,
    tools: toolService,
    systemPrompt,
  }
  if (!withoutAgents) services.agents = agentsService

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
    logger: { warn: (message) => warnings.push(String(message)) },
  }

  return { ctx, tools, handlers, archiveCalls, unarchiveCalls, messages, promptContexts, warnings, archivedIds, agentMap, entries }
}

const exec = (signal) => ({ agent: CALLER, signal })

/* ------------------------------------------------------------------ */
/* 1. registration                                                     */
/* ------------------------------------------------------------------ */

eq(name, 'team-janitor', 'plugin name')
ok(Array.isArray(inject) && inject.includes('tools'), 'inject lists the tools service')

const harness = makeContext({
  agents: {
    's-root': { status: 'idle' },
    's-a1': { status: 'idle' },
    's-a2': { status: 'running' },
    's-a3': { status: 'idle' },
  },
  archived: ['s-a5'],
})
startPlugin(harness)

const EXPECTED_TOOLS = ['team_close', 'team_overview', 'team_restore']
eq(harness.tools.size, EXPECTED_TOOLS.length, 'registers exactly three tools')
for (const toolName of EXPECTED_TOOLS) ok(harness.tools.has(toolName), `registers ${toolName}`)
ok(!harness.tools.has('team_sweep'), 'team_sweep is gone (2.x)')
for (const role of ['overview', 'close', 'restore']) {
  const definition = harness.tools.get(`team_${role}`)
  if (!definition) continue
  ok(typeof definition.execute === 'function', `team_${role} has execute`)
  ok(definition.parameters?.type === 'object', `team_${role} declares an object parameter schema`)
  ok(typeof definition.output?.render === 'function', `team_${role} declares a render`)
  ok(typeof definition.output?.schema === 'object', `team_${role} declares an output schema`)
}
ok(harness.tools.get('team_close')?.parameters?.required?.includes('agents'), 'team_close requires agents')
eq(harness.promptContexts.length, 1, 'registers one system-prompt context')

/* Every published tool carries a `when`, and no tool advertises the old sweep. */
for (const definition of harness.tools.values()) {
  ok(typeof definition.when === 'function', `${definition.name} declares a when gate`)
  ok(!/sweep/i.test(definition.description), `${definition.name} description does not advertise a sweep`)
}

/* ------------------------------------------------------------------ */
/* 2. when: declaration gate                                           */
/* ------------------------------------------------------------------ */

const overviewTool = harness.tools.get('team_overview')
const closeTool = harness.tools.get('team_close')
const restoreTool = harness.tools.get('team_restore')

for (const definition of [overviewTool, closeTool, restoreTool]) {
  eq(definition.when({ agent: ROOT }), true, `${definition.name} is declared to the tree root`)
  eq(definition.when({ agent: CALLER }), true, `${definition.name} is declared to a delegating member`)
  eq(definition.when({ agent: DELEGATING }), true, `${definition.name} is declared to a sibling that can delegate`)
  eq(definition.when({ agent: PLAIN }), false, `${definition.name} is hidden from a plain subagent`)
  eq(definition.when({}), true, `${definition.name} fails open when the context carries no agent`)
}

/** A resident member whose runtime ownership resolves to the tree root, and
    whose scope keeps no delegation tool: the gate must stay closed. */
const orphanGate = makeContext({ agents: {}, delegating: [ROOT_ID] })
startPlugin(orphanGate)
const orphanCaller = { id: 's-a2' }
eq(orphanGate.tools.get('team_overview').when({ agent: orphanCaller }), false,
  'a resident non-root member without a delegation tool is gated off')
const orphanRoot = { id: ROOT_ID, name: 'lead' }
eq(orphanGate.tools.get('team_overview').when({ agent: orphanRoot }), true,
  'the tree root keeps the tools even without a delegation tool')
const orphanPlain = { id: 's-zzz' }
eq(orphanGate.tools.get('team_overview').when({ agent: orphanPlain }), false,
  'an unknown agent with no delegation tool is refused')

/* ------------------------------------------------------------------ */
/* 3. result cache + status projection                                 */
/* ------------------------------------------------------------------ */

const onEnd = harness.handlers.get('subagent/end')
ok(typeof onEnd === 'function', 'listens to subagent/end')

/* Each known stop reason, plus one backend-specific variant. */
onEnd?.({ id: 's-a1', runId: 'run-1', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'scan finished, 3 files changed' }] })
onEnd?.({ id: 's-a2', runId: 'run-2', stopReason: 'error', lastAssistantMessage: [{ type: 'text', text: 'compile failed' }] })
onEnd?.({ id: 's-a3', runId: 'run-3', stopReason: 'refusal', lastAssistantMessage: [{ type: 'text', text: 'declined: out of scope' }] })
onEnd?.({ id: 's-a5', runId: 'run-4', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'old run' }] })
onEnd?.({ id: 's-a7', runId: 'run-5', stopReason: 'aborted' })
onEnd?.({ id: 's-a9', runId: 'run-6', stopReason: 'max-tokens', lastAssistantMessage: [{ type: 'text', text: 'cut off' }] })
/* s-a8 never reports a run -> no record at all. */
/* A malformed event must not break the dispatcher. */
onEnd?.({})
onEnd?.({ id: 42 })

const overview = await overviewTool.execute({}, exec())
assertJsonLossless(overview, 'team_overview')
eq(overview.root, ROOT_ID, 'team_overview reports the tree root')
const rowByName = new Map(overview.rows.map((row) => [row.name, row]))
eq(rowByName.get('lead')?.status, 'idle', 'the root row has no subagent result to report')
eq(rowByName.get('a-1')?.status, 'done', 'completed projects to done')
eq(rowByName.get('a-1/b-1')?.status, 'running', 'a live running turn wins over the cached result')
eq(rowByName.get('a-3')?.status, 'refused', 'refusal projects to refused')
eq(rowByName.get('a-1/e-1')?.status, 'closed', 'an archived member reports closed')
eq(rowByName.get('a-1/e-1')?.stopReason, 'completed', 'an archived member still carries its last result')
eq(rowByName.get('a-1/f-1')?.status, 'aborted', 'aborted projects to aborted')
eq(rowByName.get('a-1/h-1')?.status, 'failed', 'max-tokens projects to failed')
eq(rowByName.get('a-1/h-1')?.stopReason, 'max-tokens', 'the raw stop reason is preserved')
eq(rowByName.get('a-1/g-1')?.status, 'unknown', 'an old member with no cached result is unknown, not done')
eq(rowByName.get('a-1/g-1')?.stopReason, undefined, 'unknown carries no invented stop reason')
eq(rowByName.get('a-1/f-1')?.last, undefined, 'a run without last words has no excerpt')
ok(rowByName.get('a-1')?.last === 'scan finished, 3 files changed', 'last words come from subagent/end')
ok(rowByName.get('a-1/b-1')?.last === undefined, 'running members hide the previous run\'s words')
ok(rowByName.get('a-1/e-1')?.last === 'old run', 'closed members still show their last words')
ok(rowByName.has('a-1/diag'), 'diagnostic entries surface as rows')
eq(rowByName.get('a-1/diag')?.status, 'session unavailable', 'a diagnostic row reports its own reason')
ok(!rowByName.has('a-1/c-1'), 'one-shot children are not roster rows')
ok(rowByName.get('a-1/h-1') !== undefined, 'a member created while watching is still listed')

const text = rendered(overviewTool, overview)
ok(text.includes('a-1 [done]'), 'rendered rows use the result vocabulary')
ok(text.includes('result: done'), 'closed rows render the last result')
ok(text.includes('[failed: max-tokens]'), 'a non-canonical reason is rendered next to the status')
ok(text.includes('last: “scan finished, 3 files changed”'), 'rendered rows carry last words')

/* A variant stop reason nobody has seen yet must project to `unknown`. */
const variantHarness = makeContext({ agents: { 's-a2': { status: 'idle' } } })
startPlugin(variantHarness)
variantHarness.handlers.get('subagent/end')?.({ id: 's-a2', stopReason: 'transport-broke' })
const variant = await variantHarness.tools.get('team_overview').execute({}, exec())
const variantRow = variant.rows.find((row) => row.name === 'a-1/b-1')
eq(variantRow?.status, 'unknown', 'an unseen stop reason projects to unknown')
eq(variantRow?.stopReason, 'transport-broke', 'the unseen reason is kept verbatim')
ok(rendered(variantHarness.tools.get('team_overview'), variant).includes('[unknown: transport-broke]'),
  'an unknown status renders its raw reason')

/* Without the agents service, the catalog's `activity` is the only evidence. */
const noAgents = makeContext({ withoutAgents: true, archived: ['s-a5'] })
startPlugin(noAgents)
const degraded = await noAgents.tools.get('team_overview').execute({}, exec())
const degradedRows = new Map(degraded.rows.map((row) => [row.name, row]))
eq(degradedRows.get('a-1/b-1')?.status, 'running', 'without agents the catalog activity decides running')
eq(degradedRows.get('a-1/e-1')?.status, 'closed', 'archived still wins without the agents service')

/* lastWords:false keeps the roster but drops the words. */
const compact = await overviewTool.execute({ lastWords: false }, exec())
assertJsonLossless(compact, 'team_overview(lastWords:false)')
ok(compact.rows.every((row) => row.last === undefined), 'lastWords:false drops last words')
eq(compact.rows.length, overview.rows.length, 'lastWords:false keeps the same rows')
eq(compact.rows.find((row) => row.name === 'a-1')?.status, 'done', 'lastWords:false keeps the status')

/* ------------------------------------------------------------------ */
/* 4. closable scope and ordering                                      */
/* ------------------------------------------------------------------ */

ok(!overview.closable.includes('a-3'), 'siblings are excluded from closable')
ok(!overview.closable.includes('a-1'), 'the caller is excluded from closable')
ok(!overview.closable.includes('a-1/e-1'), 'closed members are excluded from closable')
ok(overview.closable.includes('a-1/b-1') === false, 'a running member is not offered as closable')
ok(overview.closable.includes('a-1/f-1'), 'own descendants are closable')
const firstRecorded = overview.closable.findIndex((rowName) => rowName === 'a-1/f-1')
const firstUnobserved = overview.closable.findIndex((rowName) => rowName === 'a-1/g-1')
ok(firstRecorded >= 0 && firstUnobserved >= 0 && firstRecorded < firstUnobserved,
  'members with a recorded outcome sort before unobserved ones')

/* ------------------------------------------------------------------ */
/* 5. team_close                                                       */
/* ------------------------------------------------------------------ */

const closedOne = await closeTool.execute({ agents: ['a-1/f-1'] }, exec())
assertJsonLossless(closedOne, 'team_close')
eq(closedOne.results.length, 1, 'team_close returns one row per reference')
eq(closedOne.results[0].outcome, 'closed', 'closing a descendant succeeds')
eq(closedOne.results[0].settled, true, 'settlement is observed as released')
ok(/archived/.test(closedOne.results[0].detail ?? ''), 'detail mentions archiving')
eq(harness.archiveCalls.at(-1)?.options?.stopActivity, true, 'archiving stops activity')
ok(harness.archivedIds.has('s-a7'), 'archived set now contains the closed session')

const batch = await closeTool.execute({ agents: ['a-1/e-1', 'a-1/e-1', 'a-3', 'a-1'] }, exec())
assertJsonLossless(batch, 'team_close(batch)')
eq(batch.results[0].outcome, 'already-closed', 'first reference of a closed member reports already-closed')
eq(batch.results[1].outcome, 'duplicate', 'repeated reference is deduplicated')
eq(batch.results[2].outcome, 'refused', 'sibling close is refused')
eq(batch.results[3].outcome, 'refused', 'closing yourself is refused')

const selfClose = await closeTool.execute({ agents: ['a-1'] }, exec())
eq(selfClose.results[0].outcome, 'refused', 'closing the caller stays refused')

const rootClose = await closeTool.execute({ agents: ['lead'] }, exec())
eq(rootClose.results[0].outcome, 'refused', 'closing the tree root is refused')

const typo = await closeTool.execute({ agents: ['explrerer'] }, exec())
eq(typo.results[0].outcome, 'unknown', 'an unmatched name is diagnosed as unknown, not as a foreign subtree')

/* Closing a member that keeps its inbox parked: settlement says so. */
const stubborn = makeContext({ agents: { 's-a2': { status: 'idle' } }, keepResident: true })
startPlugin(stubborn)
const stuck = await stubborn.tools.get('team_close').execute({ agents: ['a-1/b-1'] }, { agent: CALLER })
eq(stuck.results[0].settled, false, 'still-resident member reports settled=false')
ok(/still resident/.test(stuck.results[0].detail ?? ''), 'still-resident detail explains the slot risk')

/* An aborted call must not claim an unobserved verdict. */
const controller = new AbortController()
controller.abort()
const cancelled = await closeTool.execute({ agents: ['a-1/g-1'] }, { agent: CALLER, signal: controller.signal })
eq(cancelled.results[0].outcome, 'cancelled', 'an aborted call reports cancelled')

/* ------------------------------------------------------------------ */
/* 6. team_restore                                                     */
/* ------------------------------------------------------------------ */

const restored = await restoreTool.execute({ agents: ['a-1/e-1'] }, exec())
assertJsonLossless(restored, 'team_restore')
eq(restored.results[0].outcome, 'restored', 'restoring a closed member succeeds')
eq(harness.unarchiveCalls.at(-1), 's-a5', 'restore unarchives the session')
eq(harness.messages.length, 0, 'restore without prompt sends no message')

/* Restoring drops the previous run's result: the member starts over. */
const afterRestore = await overviewTool.execute({}, exec())
const reopened = afterRestore.rows.find((row) => row.name === 'a-1/e-1')
eq(reopened?.status, 'unknown', 'a restored member no longer claims its previous result')
eq(reopened?.stopReason, undefined, 'a restored member carries no stale stop reason')

const resumed = await restoreTool.execute({ agents: ['a-1/e-1', 'a-1/e-1'], prompt: 'continue the scan' }, exec())
eq(resumed.results[0].outcome, 'not-closed', 'restoring an open member reports not-closed')
eq(resumed.results[1].outcome, 'duplicate', 'restore deduplicates repeated references')

const selfRestore = await restoreTool.execute({ agents: ['a-1'] }, exec())
eq(selfRestore.results[0].outcome, 'refused', 'restoring yourself is refused instead of throwing UNAUTHORIZED')

/* Close then restore-and-continue in one sequence. */
await closeTool.execute({ agents: ['a-1/g-1'] }, exec())
const resumedNow = await restoreTool.execute({ agents: ['a-1/g-1'], prompt: 'pick up where you left off' }, exec())
eq(resumedNow.results[0].outcome, 'restored', 'restore-and-continue restores a closed member')
const lastMessage = harness.messages.at(-1)
eq(lastMessage?.targetId, 's-a8', 'prompt is delivered to the restored session')
eq(lastMessage?.content?.[0]?.type, 'text', 'prompt is delivered as a text block')

/* A one-shot child can never take a prompt: refuse before touching the archive. */
await closeTool.execute({ agents: ['a-1/c-1'] }, exec())
const promptOnOneShot = await restoreTool.execute({ agents: ['a-1/c-1'], prompt: 'continue' }, exec())
eq(promptOnOneShot.results[0].outcome, 'refused', 'prompt on a non-continuable member is refused')
ok(/not continuable/.test(promptOnOneShot.results[0].detail ?? ''), 'non-continuable refusal explains itself')

/* ------------------------------------------------------------------ */
/* 7. hygiene context                                                  */
/* ------------------------------------------------------------------ */

const hygieneAll = harness.promptContexts[0]?.text?.({ agent: CALLER, scope: CALLER, toolSet: new Set(EXPECTED_TOOLS) })
ok(typeof hygieneAll === 'string' && hygieneAll.includes('team_close'), 'hygiene context mentions team_close')
ok(hygieneAll.includes('team_overview'), 'hygiene context mentions team_overview')
ok(!hygieneAll.includes('team_sweep'), 'hygiene context never mentions team_sweep')
ok(hygieneAll.length < 260, 'hygiene context stays short')

const hygienePlain = harness.promptContexts[0]?.text?.({ agent: PLAIN, scope: PLAIN, toolSet: new Set(EXPECTED_TOOLS) })
eq(hygienePlain, '', 'a plain subagent gets no hygiene nudge (its tools are gated off)')

const hygienePartial = harness.promptContexts[0]?.text?.({ agent: CALLER, scope: CALLER, toolSet: new Set(['team_close']) })
ok(hygienePartial.includes('team_close'), 'a restricted tool set still advertises the visible tool')
ok(!hygienePartial.includes('team_overview'), 'a restricted tool set does not advertise a hidden tool')
ok(!hygienePartial.includes('team_restore'), 'a restricted tool set does not advertise team_restore')

const hygieneNone = harness.promptContexts[0]?.text?.({ agent: CALLER, scope: CALLER, toolSet: new Set() })
eq(hygieneNone, '', 'no visible tool means no hygiene sentence')

/* Request-time refresh passes no toolSet: the gate must still apply. */
const hygieneRefresh = harness.promptContexts[0]?.text?.({ agent: PLAIN, scope: PLAIN })
eq(hygieneRefresh, '', 'a plain subagent gets no nudge on request-time refresh either')

/* ------------------------------------------------------------------ */
/* 8. model-facing declaration budget                                  */
/* ------------------------------------------------------------------ */

const wire = [...harness.tools.values()].map((definition) => ({
  type: 'function',
  function: { name: definition.name, description: definition.description, parameters: definition.parameters },
}))
const wireSize = wire.reduce((total, item) => total + JSON.stringify(item).length, 0)
ok(wireSize <= 1500, `three tool declarations stay within 1500 characters (${wireSize})`, wireSize)
for (const item of wire) {
  ok(typeof item.function.name === 'string' && item.function.name.length > 0, `${item.function.name} has a name`)
  ok(typeof item.function.description === 'string' && item.function.description.length > 0, `${item.function.name} has a description`)
  ok(item.function.parameters !== undefined, `${item.function.name} has parameters`)
}

/* ------------------------------------------------------------------ */
/* 9. durable result store                                             */
/* ------------------------------------------------------------------ */

/* Every case below writes under TEMP_ROOT (via DSH_HOME); the real
   ~/.dsh/team-janitor is never touched by this suite. */

/* (a) one coalesced write covers a burst, and the file has the documented shape. */
const writer = startPlugin(makeContext({ agents: { 's-a2': { status: 'idle' } } }))
const writeEnd = writer.handlers.get('subagent/end')
writeEnd?.({ id: 's-a2', runId: 'run-p1', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'persisted words' }] })
writeEnd?.({ id: 's-a7', runId: 'run-p2', stopReason: 'aborted' })
writeEnd?.({ id: 's-a8', runId: 'run-p3', stopReason: 'refusal', lastAssistantMessage: [{ type: 'text', text: 'no' }] })
await sleep(150)
ok(!existsSync(writer.resultsFile), 'a burst inside the write window leaves no file yet (writes are coalesced)')
await sleep(700)
ok(existsSync(writer.resultsFile), 'the results file appears once the write window closes')
const saved = JSON.parse(readFileSync(writer.resultsFile, 'utf8'))
eq(saved.version, 1, 'the results file carries version 1')
eq(typeof saved.updatedAt, 'number', 'the results file carries updatedAt')
eq(Object.keys(saved.results).length, 3, 'one write covered all three runs')
eq(saved.results['s-a2']?.stopReason, 'completed', 'stopReason is persisted')
eq(saved.results['s-a2']?.excerpt, 'persisted words', 'last words are persisted')
eq(saved.results['s-a2']?.runId, 'run-p1', 'runId is persisted')
eq(typeof saved.results['s-a2']?.endedAt, 'number', 'endedAt is persisted')
ok(!existsSync(`${writer.resultsFile}.tmp`), 'the atomic write leaves no temp file behind')

/* (b) a simulated restart: a brand-new plugin instance reads the file back. */
const restarted = startPlugin(
  makeContext({ agents: { 's-a2': { status: 'idle' } } }),
  { dshHome: writer.dshHome },
)
const reloaded = await restarted.tools.get('team_overview').execute({}, exec())
const reloadedRows = new Map(reloaded.rows.map((row) => [row.name, row]))
eq(reloadedRows.get('a-1/b-1')?.status, 'done', 'after a restart the persisted completed run still projects to done')
eq(reloadedRows.get('a-1/b-1')?.last, 'persisted words', 'after a restart the persisted last words are still shown')
eq(reloadedRows.get('a-1/f-1')?.status, 'aborted', 'after a restart the persisted aborted run projects to aborted')
eq(reloadedRows.get('a-1/g-1')?.status, 'refused', 'after a restart the persisted refusal projects to refused')
eq(reloadedRows.get('a-1')?.status, 'unknown', 'a member with no record anywhere is still unknown after a restart')
ok(reloadedRows.get('a-1/b-1')?.status !== 'unknown',
  'a persisted record beats watchingSince (a restart does not erase known results)')

/* (c) a corrupt file never breaks activation: it is moved aside, cache empty. */
const corruptHome = join(TEMP_ROOT, 'corrupt')
mkdirSync(join(corruptHome, 'team-janitor'), { recursive: true })
writeFileSync(resultsFileFor(corruptHome), '{ this is not json', 'utf8')
const corrupt = startPlugin(makeContext({}), { dshHome: corruptHome })
ok(corrupt.warnings.some((message) => /results\.json\.corrupt/.test(message)), 'a corrupt file produces one warning')
ok(existsSync(`${corrupt.resultsFile}.corrupt`), 'the unreadable file is renamed to results.json.corrupt')
const afterCorrupt = await corrupt.tools.get('team_overview').execute({}, exec())
eq(afterCorrupt.rows.find((row) => row.name === 'a-1')?.status, 'unknown', 'a corrupt file leaves an empty cache')

/* A wrong version is a shape problem, not a crash either. */
const wrongVersionHome = join(TEMP_ROOT, 'wrong-version')
mkdirSync(join(wrongVersionHome, 'team-janitor'), { recursive: true })
writeFileSync(resultsFileFor(wrongVersionHome), JSON.stringify({ version: 99, results: {} }), 'utf8')
const wrongVersion = startPlugin(makeContext({}), { dshHome: wrongVersionHome })
ok(existsSync(`${wrongVersion.resultsFile}.corrupt`), 'an unexpected file version is quarantined too')

/* (d) team_restore removes the record from the file, not just from memory. */
const restoreHome = join(TEMP_ROOT, 'restore')
mkdirSync(join(restoreHome, 'team-janitor'), { recursive: true })
writeFileSync(resultsFileFor(restoreHome), JSON.stringify({
  version: 1,
  updatedAt: 1,
  results: { 's-a5': { stopReason: 'completed', endedAt: 1, excerpt: 'old run' } },
}), 'utf8')
const restorer = startPlugin(makeContext({ archived: ['s-a5'] }), { dshHome: restoreHome })
eq(JSON.parse(readFileSync(restorer.resultsFile, 'utf8')).results['s-a5']?.stopReason, 'completed',
  'the seeded record is loaded from disk')
const seeded = await restorer.tools.get('team_overview').execute({}, exec())
eq(seeded.rows.find((row) => row.name === 'a-1/e-1')?.status, 'closed', 'the seeded member still reports closed')
ok(rendered(restorer.tools.get('team_overview'), seeded).includes('result: done'),
  'the seeded member still renders its persisted result')
await restorer.tools.get('team_restore').execute({ agents: ['a-1/e-1'] }, exec())
eq(JSON.parse(readFileSync(restorer.resultsFile, 'utf8')).results['s-a5'], undefined,
  'restoring deletes the record from the file synchronously')

/* (e) the file keeps the same 256-entry cap as the memory cache. */
const capped = startPlugin(makeContext({}))
const capEnd = capped.handlers.get('subagent/end')
for (let index = 0; index < 300; index += 1) capEnd?.({ id: `s-gen-${index}`, stopReason: 'completed' })
await sleep(800)
const cappedFile = JSON.parse(readFileSync(capped.resultsFile, 'utf8'))
eq(Object.keys(cappedFile.results).length, 256, 'the written file keeps the 256-entry cap')
ok(cappedFile.results['s-gen-299'] !== undefined, 'the newest record survives the cap')
ok(cappedFile.results['s-gen-0'] === undefined, 'the oldest record is evicted')

/* (f) persistResults:false keeps everything in memory only. */
const memoryOnly = startPlugin(makeContext({ agents: { 's-a8': { status: 'idle' } } }), { config: { persistResults: false } })
memoryOnly.handlers.get('subagent/end')?.({ id: 's-a8', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'memory only' }] })
await sleep(700)
ok(!existsSync(memoryOnly.resultsFile), 'persistResults:false writes no file')
const memoryView = await memoryOnly.tools.get('team_overview').execute({}, exec())
eq(memoryView.rows.find((row) => row.name === 'a-1/g-1')?.status, 'done', 'persistResults:false still answers from memory')

/* (g) the store lives in DSH_HOME, never inside the repository. */
ok(!existsSync(join(repo, 'team-janitor')), 'the repository contains no store directory')

/* ------------------------------------------------------------------ */
/* 10. packaging invariants                                            */
/* ------------------------------------------------------------------ */

const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
eq(pkg.version, '2.1.0', 'the durable store ships as 2.1.0')
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

/* The removed tool must be gone from every shipped artefact, docs aside. */
for (const file of ['lib/index.js', 'client.js', 'package.json', 'locale/en.json', 'locale/zh.json']) {
  const source = await readFile(join(repo, file), 'utf8')
  ok(!/team_sweep/.test(source), `${file} no longer references team_sweep`)
}
const host = await readFile(join(repo, 'lib/index.js'), 'utf8')
ok(/when:\s*\(context\)/.test(host), 'tools are registered with a when gate')
ok(host.includes('archiveSession'), 'closing still goes through archiveSession')
/* The Host half may write exactly one file: its own results mirror. */
ok(/writeFileSync\(temp, payload\(map\)/.test(host), 'the only file write targets the store temp file')
ok(/renameSync\(temp, file\)/.test(host), 'file writes are atomic (temp + rename)')
ok(!/\brm\(|unlink\(|rmdir\(/.test(host), 'the Host half never deletes files')
ok(!/session\.v4|sessions\//.test(host), 'the Host half never touches session logs')
ok(!/(?:from\s*|require\()\s*['"]node:/.test(clientSource), 'client.js imports no Node built-in')
ok(/(?:from\s*|import\()\s*['"]node:(?:fs|os|path)['"]/.test(host), 'the Host half may import Node built-ins')

/* The only in-process timer must not keep the host alive. */
ok(/timer\.unref\?\.\(\)/.test(host), 'the write timer is unref-ed')
ok(!pkg.files?.some?.((entry) => /results\.json/.test(String(entry))), 'the package never ships a results file')

/* Clean up the throwaway stores this run created. */
rmSync(TEMP_ROOT, { recursive: true, force: true })

/* ------------------------------------------------------------------ */

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks failed`)
  process.exit(1)
}
console.log(`✓ ${checks} checks passed`)
