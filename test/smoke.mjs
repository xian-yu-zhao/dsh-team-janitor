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
    logger: { warn: () => {} },
  }

  return { ctx, tools, handlers, archiveCalls, unarchiveCalls, messages, promptContexts, archivedIds, agentMap, entries }
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
apply(harness.ctx)

const EXPECTED_TOOLS = ['team_close', 'team_overview', 'team_restore']
eq(harness.tools.size, EXPECTED_TOOLS.length, 'registers exactly three tools')
for (const toolName of EXPECTED_TOOLS) ok(harness.tools.has(toolName), `registers ${toolName}`)
ok(!harness.tools.has('team_sweep'), 'team_sweep is gone in 2.0.0')
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
apply(orphanGate.ctx)
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
apply(variantHarness.ctx)
variantHarness.handlers.get('subagent/end')?.({ id: 's-a2', stopReason: 'transport-broke' })
const variant = await variantHarness.tools.get('team_overview').execute({}, exec())
const variantRow = variant.rows.find((row) => row.name === 'a-1/b-1')
eq(variantRow?.status, 'unknown', 'an unseen stop reason projects to unknown')
eq(variantRow?.stopReason, 'transport-broke', 'the unseen reason is kept verbatim')
ok(rendered(variantHarness.tools.get('team_overview'), variant).includes('[unknown: transport-broke]'),
  'an unknown status renders its raw reason')

/* Without the agents service, the catalog's `activity` is the only evidence. */
const noAgents = makeContext({ withoutAgents: true, archived: ['s-a5'] })
apply(noAgents.ctx)
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
apply(stubborn.ctx)
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
/* 9. packaging invariants                                             */
/* ------------------------------------------------------------------ */

const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
eq(pkg.version, '2.0.0', 'breaking release is versioned 2.0.0')
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
ok(!/rm\(|unlink\(|rmdir\(|writeFile/.test(host), 'the Host half never touches files')

/* ------------------------------------------------------------------ */

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks failed`)
  process.exit(1)
}
console.log(`✓ ${checks} checks passed`)
