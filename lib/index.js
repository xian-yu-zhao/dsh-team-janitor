/**
 * @local/team-janitor — team collaboration QoL for DSH.
 *
 * Two things DSH leaves to the model:
 *   - team_overview: each member's *result* (who finished, failed, refused,
 *     aborted) plus its last words — the gap `list_agents` leaves, whose
 *     `inactive` says nothing about completion;
 *   - team_close / team_restore: reversible archiving of used-up members.
 *
 * Mechanism (public APIs only): closing = workspaceRegistry.archiveSession(
 * childId, { stopActivity: true }) — the workspace registry cancels the
 * session's own running turn (agent.cancel({kind:'user'})) and the subagent
 * runtime cancels running descendants (parent cause); the durable session
 * leaves the workspace and team_restore unarchives it. Later model steps are
 * blocked by DSH's built-in session gates (self-archived plus managed-ancestor
 * admission) — no plugin gate needed since DSH 44.7.0.
 * Result cache: `subagent/end` carries { runId, id, stopReason,
 * lastAssistantMessage? }; results are cached in-process (256-entry FIFO) and
 * are LOST on restart, which is why the roster says `unknown` instead of
 * claiming a member never ran.
 * Capacity honesty: a normally finished subagent settles by itself and frees
 * its slot; archiving an idle member does not guarantee a freed slot when
 * parked input remains in its inbox (no public dispose/inbox-clear API).
 * No @deepseek-ai imports on purpose: fully self-contained ESM.
 * @module dsh-team-janitor
 */

const TEXT = (text) => [{ type: 'text', text }]

export const name = 'team-janitor'
/* Hard dependencies only: `agent`-registry access and `systemPrompt` are read
   with ctx.get(name) + undefined guards, so a composition without them still
   loads (status/settlement degrade, no hygiene nudge) instead of dropping the
   whole plugin at activation time. */
export const inject = ['tools', 'subagents']

/* ------------------------------------------------------------------ */
/* result vocabulary                                                   */
/* ------------------------------------------------------------------ */

/**
 * How a subagent run's `stopReason` projects onto the roster vocabulary.
 * Known reasons (dsh-subagent `SubagentStopReasonMap`): completed, aborted,
 * error, max-tokens, refusal. The union is merge-extensible, so an unknown
 * variant projects to 'unknown' — never guessed into 'done'.
 */
const RESULT_STATUS = Object.freeze({
  completed: 'done',
  error: 'failed',
  'max-tokens': 'failed',
  refusal: 'refused',
  aborted: 'aborted',
})

/** Roster vocabulary: result first, residency only where it is all we know. */
const STATUS_VALUES = ['running', 'done', 'failed', 'refused', 'aborted', 'idle', 'closed', 'unknown']

/** The stop reason a status already implies; any other reason is rendered too. */
const CANONICAL_REASON = Object.freeze({
  done: 'completed',
  failed: 'error',
  refused: 'refusal',
  aborted: 'aborted',
})

/** Closing order: members with a recorded outcome first, unobserved ones after. */
const CLOSE_RANK = Object.freeze({
  done: 0, failed: 0, refused: 0, aborted: 0, idle: 1, unknown: 1,
})

/** Roster tokens are paid on every call: keep only enough to judge "used up?". */
const EXCERPT_LIMIT = 100
/** Bounded derived cache — a long-lived session can see thousands of runs. */
const RESULT_LIMIT = 256

/** Delegation tools register as `subagent`, `subagent_fork`, or a custom `subagent_*`. */
const DELEGATION_TOOL = /^subagent(?:[_-]|$)/

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Whether a member's turn is in flight, from the agents registry when available. */
function isRunning(agents, id, entry) {
  if (typeof agents?.get === 'function') {
    const agent = agents.get(id)
    if (agent !== undefined) return agent.status === 'running'
  }
  /* Without the agents registry the catalog row is the only evidence. */
  return entry?.activity === 'running'
}

/**
 * Roster status of one member: result first, then residency, and `unknown`
 * whenever the process-local cache cannot answer the question.
 */
function memberStatus({ archived, results, agents, id, entry, watchingSince }) {
  if (archived.has(id)) return 'closed'
  if (isRunning(agents, id, entry)) return 'running'
  const record = results.get(id)
  if (record !== undefined) return RESULT_STATUS[record.stopReason] ?? 'unknown'
  /* No record. The cache is process-local, so a member created before this
     plugin started watching may have finished unseen: say 'unknown' rather
     than claim it never ran. */
  if (entry === undefined) return 'idle'
  if (typeof entry.createdAt === 'number' && entry.createdAt >= watchingSince) return 'idle'
  return 'unknown'
}

/**
 * Ids of catalog entries that hang strictly under `ownerId` (owner excluded).
 * `entries` are listDescendants rows; diagnostics have no reliable parentId
 * and are treated as under their recorded parent when reachable.
 */
function idsUnder(entries, rootId, ownerId) {
  const parentOf = new Map()
  for (const entry of entries) {
    if (entry.kind === 'diagnostic') continue
    parentOf.set(entry.id, entry.parentId)
  }
  const under = new Set()
  for (const id of parentOf.keys()) {
    /* Strictly under: the owner itself is never in its own subtree. */
    if (id === ownerId) continue
    let cursor = id
    const seen = new Set()
    let ok = false
    while (!seen.has(cursor)) {
      seen.add(cursor)
      if (cursor === ownerId) { ok = true; break }
      const next = parentOf.get(cursor)
      if (next === undefined) break
      cursor = next
    }
    if (ok) under.add(id)
  }
  return under
}

/** Names of running catalog entries inside `ids` (bounded, stable order). */
function runningNames(entries, agents, ids) {
  const names = []
  for (const entry of entries) {
    if (!ids.has(entry.id)) continue
    if (entry.kind === 'diagnostic') continue
    if (isRunning(agents, entry.id, entry)) names.push(entry.path ?? entry.id)
  }
  return names
}

/**
 * Shared settlement poll over many ids: one timer loop with a single budget,
 * so closing 12 members costs ~2s in total instead of ~2s per member. Resolves
 * Map<id, true|false|'cancelled'> — true once the id left the agents registry
 * (disposed ⇒ slot released), false when the budget ran out with the member
 * still resident, 'cancelled' when the call was aborted before a verdict (an
 * aborted call must not claim an unobserved outcome). When the agents service
 * is unavailable the map is empty (settlement cannot be observed at all).
 * Plain setTimeout polling — no dependencies, honors exec.signal.
 */
function settleMany(agents, ids, signal, budgetMs = 2000, stepMs = 200) {
  const state = new Map()
  if (typeof agents?.get !== 'function' || ids.length === 0) return Promise.resolve(state)
  return new Promise((resolve) => {
    const deadline = Date.now() + budgetMs
    const tick = () => {
      let pending = 0
      for (const id of ids) {
        if (state.has(id)) continue
        if (!agents.get(id)) state.set(id, true)
        else pending += 1
      }
      if (signal?.aborted) {
        for (const id of ids) if (!state.has(id)) state.set(id, 'cancelled')
        return resolve(state)
      }
      if (pending === 0 || Date.now() >= deadline) {
        for (const id of ids) if (!state.has(id)) state.set(id, false)
        return resolve(state)
      }
      setTimeout(tick, stepMs)
    }
    tick()
  })
}

/**
 * One rendered roster row: `name [status]`, optional label/session, the raw
 * stop reason when it is not what the status already says, and last words.
 */
function line(row) {
  const derived = row.stopReason === undefined ? undefined : (RESULT_STATUS[row.stopReason] ?? 'unknown')
  /* Show the raw reason whenever the status alone would not say it: a token
     ceiling reads as `failed` too, and an unseen backend variant as `unknown`. */
  const tag = row.stopReason !== undefined && row.status !== 'closed' && CANONICAL_REASON[row.status] !== row.stopReason
    ? `${row.status}: ${row.stopReason}`
    : row.status
  const parts = [`${row.name} [${tag}]`]
  if (row.label !== undefined) parts.push(`— ${row.label}`)
  if (row.session !== undefined && row.session !== row.name) parts.push(`(${row.session})`)
  /* An archived member still answers "how did its last run end?". */
  if (row.status === 'closed' && derived !== undefined) {
    parts.push(CANONICAL_REASON[derived] === row.stopReason ? `result: ${derived}` : `result: ${derived} (${row.stopReason})`)
  }
  if (row.last !== undefined) parts.push(`last: “${row.last}”`)
  return parts.join(' ')
}

/** Defensive excerpt extraction for the run's last assistant message. */
function excerptOf(value) {
  let text = ''
  if (typeof value === 'string') text = value
  else if (Array.isArray(value)) {
    text = value
      .map((block) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
      .join(' ')
  } else if (value && typeof value === 'object') {
    if (typeof value.text === 'string') text = value.text
    else if (Array.isArray(value.content)) text = excerptOf(value.content)
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT - 1)}…` : text
}

/** Recursively drop undefined properties so the canonical value stays lossless JSON. */
function plain(value) {
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = plain(item)
    }
    return out
  }
  return value
}

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

function buildTools(ctx, results, watchingSince) {
  const subagents = ctx.get('subagents')
  const agents = ctx.get('agents')
  const registry = () => {
    const service = ctx.get('workspaceRegistry')
    return service && typeof service.archiveSession === 'function' ? service : undefined
  }

  /** Shared read: live root, catalog rows, archived set, subtree-under map. */
  async function snapshot(caller, signal) {
    const root = subagents.rootOf(caller)
    const entries = await subagents.listDescendants(root.id, signal)
    const service = registry()
    const archived = new Set(service?.archivedSessionIds ?? [])
    return { root, entries, archived, service, under: idsUnder(entries, root.id, caller.id) }
  }

  const overview = {
    name: 'team_overview',
    description:
      'Outcome view of your subagent tree: per member status + last words. '
      + 'list_agents\' inactive says nothing about success, failure, or refusal — this does. '
      + 'Status: running, done, failed, refused, aborted, idle, closed, unknown (no run recorded since load; the cache is in-process). '
      + 'closable = descendants you may close.',
    parameters: {
      type: 'object',
      properties: {
        lastWords: {
          type: 'boolean',
          description: 'Default true.',
        },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: {
          root: { type: 'string' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                session: { type: 'string', description: 'Session id; omitted from the rendered text when it equals name.' },
                status: { type: 'string', description: `One of ${STATUS_VALUES.join(' | ')}; a read diagnostic contributes its own reason.` },
                label: { type: 'string' },
                stopReason: { type: 'string', description: 'Raw stopReason of the last recorded run (completed | aborted | error | max-tokens | refusal, or a backend variant).' },
                last: { type: 'string', description: 'Last words of the member\'s last recorded run; omitted while it is running.' },
              },
              required: ['name', 'session', 'status'],
            },
          },
          closable: { type: 'array', items: { type: 'string' } },
        },
        required: ['root', 'rows', 'closable'],
      },
      render: (_args, value) => {
        const lines = value.rows.map((row) => line(row))
        if (value.closable.length > 0) lines.push(`closable: ${value.closable.join(', ')}`)
        return TEXT(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('team_overview requires a calling agent (exec.agent was undefined)')
      const showLast = args.lastWords !== false
      const { root, entries, archived, under } = await snapshot(caller, exec.signal)
      const state = { archived, results, agents, watchingSince }

      const rootRunning = isRunning(agents, root.id)
      const rows = [{
        name: root.name ?? 'lead',
        session: root.id,
        status: archived.has(root.id) ? 'closed' : rootRunning ? 'running' : 'idle',
        label: 'root agent',
      }]

      const closable = []
      for (const entry of entries) {
        if (entry.kind === 'diagnostic') {
          rows.push({ name: entry.path ?? entry.id, session: entry.id, status: entry.reason ?? 'unavailable' })
          continue
        }
        /* One-shot children are excluded on purpose: the runtime delivers their
           result straight to the parent, so they need no roster row. */
        if (entry.mode !== 'continuable') continue
        const id = entry.id
        const status = memberStatus({ ...state, id, entry })
        const record = results.get(id)
        const row = {
          name: entry.path ?? entry.id,
          session: id,
          status,
          label: entry.label,
          stopReason: record?.stopReason,
          /* While a turn is in flight the recorded result belongs to an older run. */
          last: showLast && status !== 'running' && record?.excerpt ? record.excerpt : undefined,
        }
        rows.push(row)
        if (id === caller.id) continue
        /* Rows cover the whole tree (useful context), but only the caller's own
           finished-or-unobserved descendants are offered: a sibling listed as
           closable would just be refused by team_close, and a running member is
           not "used up" — team_close can still be pointed at it by name. */
        if (!under.has(id) || status === 'closed' || status === 'running') continue
        closable.push({ name: row.name, rank: CLOSE_RANK[status] ?? 1 })
      }
      /* Used-up members first: that is the list the model is about to act on. */
      closable.sort((a, b) => a.rank - b.rank)
      return plain({ root: root.id, rows, closable: closable.map((item) => item.name) })
    },
  }

  const close = {
    name: 'team_close',
    description:
      'Archive subagents you are done with (reversible; nothing deleted) and stop their work. Reports whether each settled. '
      + 'Closed members refuse steps until team_restore. Own descendants only (not yourself or the root).',
    parameters: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names or session ids.',
        },
      },
      required: ['agents'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                agent: { type: 'string' },
                session: { type: 'string' },
                outcome: {
                  type: 'string',
                  enum: ['closed', 'already-closed', 'duplicate', 'unknown', 'refused', 'cancelled', 'failed'],
                  description: 'closed = archived now; already-closed = was archived before; duplicate = repeated reference; unknown = no such member; refused = outside your subtree / self / root; cancelled = call aborted; failed = error.',
                },
                detail: { type: 'string' },
                settled: { type: 'boolean', description: 'true = left the agents registry (slot released); false = still resident after the poll; omitted when the outcome could not be observed.' },
              },
              required: ['agent', 'outcome'],
            },
          },
        },
        required: ['results'],
      },
      render: (_args, value) => TEXT(value.results.map((row) => {
        const where = row.session === undefined ? '' : ` (session ${row.session})`
        const detail = row.detail === undefined ? '' : `: ${row.detail}`
        return `${row.outcome} agent ${row.agent}${where}${detail}`
      }).join('\n')),
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('team_close requires a calling agent (exec.agent was undefined)')
      const service = registry()
      if (!service) throw new Error('workspaceRegistry service is unavailable in this composition; cannot close sessions')
      const { root, entries, archived, under } = await snapshot(caller, exec.signal)

      /* Phase 1: resolve, validate and archive each reference in input order.
         Phase 2 polls settlement once for the whole batch, so closing twelve
         members costs one poll budget instead of twelve sequential ones. */
      const plan = []
      const seen = new Set()
      for (const reference of args.agents) {
        if (exec.signal?.aborted) {
          plan.push({ agent: reference, outcome: 'cancelled', detail: 'call cancelled before this target was handled' })
          continue
        }
        try {
          const targetId = await subagents.resolveName(caller, reference, exec.signal)
          const entry = entries.find((row) => row.id === targetId && row.kind !== 'diagnostic')
          const name = entry?.path ?? reference
          if (seen.has(targetId)) {
            plan.push({ agent: name, session: targetId, outcome: 'duplicate', detail: 'already handled earlier in this call' })
            continue
          }
          seen.add(targetId)
          /* Self and root first: the root is not in its own descendant list, so
             an entry lookup would mislabel this as "no such member". */
          if (targetId === caller.id) {
            plan.push({ agent: reference, outcome: 'refused', detail: 'you cannot close yourself' })
            continue
          }
          if (targetId === root.id) {
            plan.push({ agent: reference, outcome: 'refused', detail: 'the tree root cannot be closed' })
            continue
          }
          if (!entries.some((row) => row.id === targetId)) {
            plan.push({ agent: reference, outcome: 'unknown', detail: 'no member of this tree has that name or session id' })
            continue
          }
          if (!under.has(targetId)) {
            plan.push({ agent: reference, outcome: 'refused', detail: 'not one of your descendants' })
            continue
          }
          if (archived.has(targetId)) {
            plan.push({ agent: name, session: targetId, outcome: 'already-closed' })
            continue
          }
          const stopped = runningNames(entries, agents, idsUnder(entries, root.id, targetId))
          await service.archiveSession(targetId, { stopActivity: true })
          archived.add(targetId)
          plan.push({ agent: name, session: targetId, outcome: 'closed', stopped })
        } catch (error) {
          plan.push({ agent: reference, outcome: 'failed', detail: error instanceof Error ? error.message : String(error) })
        }
      }

      const closing = plan.filter((row) => row.outcome === 'closed')
      const settledMap = await settleMany(agents, closing.map((row) => row.session), exec.signal)
      return plain({
        results: plan.map((row) => {
          if (row.outcome !== 'closed') return row
          const settled = settledMap.get(row.session)
          const notes = ['archived; stop requested']
          if (row.stopped.length > 0) notes.push(`stop requested for running descendants: ${row.stopped.join(', ')}`)
          if (settled === true) notes.push('settled, slot released')
          else if (settled === false) notes.push('still resident — slot may be retained (parked inbox input)')
          else if (settled === 'cancelled') notes.push('settlement not observed (call cancelled)')
          else notes.push('settlement not observed (agents registry unavailable)')
          return {
            agent: row.agent,
            session: row.session,
            outcome: 'closed',
            detail: notes.join('; '),
            settled: typeof settled === 'boolean' ? settled : undefined,
          }
        }),
      })
    },
  }

  const restore = {
    name: 'team_restore',
    description:
      'Reopen closed subagents so they can take steps again. With prompt the message is delivered after unarchiving; '
      + 'without it nothing starts. Own subtree only.',
    parameters: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names or session ids.',
        },
        prompt: {
          type: 'string',
          description: 'Delivered after unarchiving.',
        },
      },
      required: ['agents'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                agent: { type: 'string' },
                session: { type: 'string' },
                outcome: {
                  type: 'string',
                  enum: ['restored', 'not-closed', 'duplicate', 'unknown', 'refused', 'cancelled', 'failed'],
                  description: 'restored = unarchived now; not-closed = was not archived; duplicate = repeated reference; unknown = no such member; refused = outside your subtree / self / not continuable; cancelled = call aborted; failed = error.',
                },
                detail: { type: 'string' },
              },
              required: ['agent', 'outcome'],
            },
          },
        },
        required: ['results'],
      },
      render: (_args, value) => TEXT(value.results.map((row) => {
        const where = row.session === undefined ? '' : ` (session ${row.session})`
        const detail = row.detail === undefined ? '' : `: ${row.detail}`
        return `${row.outcome} agent ${row.agent}${where}${detail}`
      }).join('\n')),
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('team_restore requires a calling agent (exec.agent was undefined)')
      const service = registry()
      if (!service) throw new Error('workspaceRegistry service is unavailable in this composition; cannot restore sessions')
      const { root, entries, archived, under } = await snapshot(caller, exec.signal)
      /* Local name on purpose: `results` is the process-local run cache here. */
      const rows = []
      const seen = new Set()
      const wantsPrompt = typeof args.prompt === 'string' && args.prompt.length > 0
      for (const reference of args.agents) {
        if (exec.signal?.aborted) {
          rows.push({ agent: reference, outcome: 'cancelled', detail: 'call cancelled before this target was handled' })
          continue
        }
        try {
          const targetId = await subagents.resolveName(caller, reference, exec.signal)
          const entry = entries.find((row) => row.id === targetId && row.kind !== 'diagnostic')
          const name = entry?.path ?? reference
          if (seen.has(targetId)) {
            rows.push({ agent: name, session: targetId, outcome: 'duplicate', detail: 'already handled earlier in this call' })
            continue
          }
          seen.add(targetId)
          if (targetId === caller.id) {
            rows.push({ agent: reference, outcome: 'refused', detail: 'you cannot restore yourself' })
            continue
          }
          if (targetId === root.id) {
            rows.push({ agent: reference, outcome: 'refused', detail: 'the tree root is not a member' })
            continue
          }
          if (!entries.some((row) => row.id === targetId)) {
            rows.push({ agent: reference, outcome: 'unknown', detail: 'no member of this tree has that name or session id' })
            continue
          }
          if (!under.has(targetId)) {
            rows.push({ agent: reference, outcome: 'refused', detail: 'not in your subtree' })
            continue
          }
          /* A one-shot/external child cannot be continued, and sendMessage has
             nothing to wake — restoring it with a prompt can only fail, so say
             so before touching the archive at all. */
          if (wantsPrompt && entry?.mode !== 'continuable') {
            rows.push({ agent: name, session: targetId, outcome: 'refused', detail: 'not continuable: restore without prompt' })
            continue
          }
          if (!archived.has(targetId)) {
            rows.push({ agent: name, session: targetId, outcome: 'not-closed' })
            continue
          }
          await service.unarchiveSession(targetId)
          archived.delete(targetId)
          /* The recorded result belongs to the run before the reopen. */
          results.delete(targetId)
          if (wantsPrompt) {
            try {
              await subagents.sendMessage(caller, targetId, TEXT(args.prompt), { signal: exec.signal })
              rows.push({ agent: name, session: targetId, outcome: 'restored', detail: 'restored; message accepted — a cold target resumes and occupies a slot' })
            } catch (deliveryError) {
              const why = deliveryError instanceof Error ? deliveryError.message : String(deliveryError)
              rows.push({ agent: name, session: targetId, outcome: 'restored', detail: `restored but message failed: ${why}` })
            }
          } else {
            rows.push({ agent: name, session: targetId, outcome: 'restored' })
          }
        } catch (error) {
          rows.push({ agent: reference, outcome: 'failed', detail: error instanceof Error ? error.message : String(error) })
        }
      }
      return plain({ results: rows })
    },
  }

  return [overview, close, restore]
}

/* ------------------------------------------------------------------ */
/* apply                                                               */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const subagents = ctx.get('subagents')
  const tools = ctx.get('tools')
  /* Every tool calls rootOf + listDescendants + resolveName; a partial service
     would only fail later, inside a tool call. Stay idle instead. */
  const REQUIRED_SUBAGENT_METHODS = ['rootOf', 'listDescendants', 'resolveName']
  const capable = subagents && REQUIRED_SUBAGENT_METHODS.every((method) => typeof subagents[method] === 'function')
  if (!capable || !tools) {
    ctx.logger?.warn?.('[team-janitor] subagents/tools services unavailable or incomplete; plugin stays idle')
    return
  }

  const results = new Map()
  /* Members created before this instant may have finished unseen: the cache
     cannot tell "never ran" from "ran before we were listening". */
  const watchingSince = Date.now()

  /**
   * Step-time gate: these tools are only declared for an agent that can spawn
   * subagents (its scope sees a delegation tool) or that owns the live
   * subagent tree root. Anything else — a plain child without delegation —
   * gets no definition and no hygiene nudge.
   * Fail-open when the context carries no agent (should not happen for a model
   * step, and hiding the tools on a context we cannot read would be worse).
   */
  function canManageTeam(agent) {
    if (agent === undefined || typeof agent?.id !== 'string') return true
    try {
      if (subagents.rootOf(agent)?.id === agent.id) return true
    } catch {
      /* No live runtime owner: falls through to the tool-visibility probe. */
    }
    try {
      const visible = tools.definitions?.(agent) ?? []
      return visible.some((definition) => DELEGATION_TOOL.test(definition.name))
    } catch {
      return false
    }
  }

  const definitions = buildTools(ctx, results, watchingSince)
  for (const definition of definitions) {
    ctx.effect(() => tools.register(definition, {
      when: (context) => canManageTeam(context?.agent),
    }))
  }

  /** Cache each member's run outcome when it settles (process-local derived cache). */
  ctx.effect(() =>
    ctx.on?.('subagent/end', (info) => {
      try {
        if (!info || typeof info.id !== 'string') return
        const record = {
          stopReason: typeof info.stopReason === 'string' ? info.stopReason : 'unknown',
          endedAt: Date.now(),
          excerpt: excerptOf(info.lastAssistantMessage),
          runId: info.runId,
        }
        results.delete(info.id)
        results.set(info.id, record)
        while (results.size > RESULT_LIMIT) {
          const oldest = results.keys().next().value
          if (oldest === undefined) break
          results.delete(oldest)
        }
      } catch {
        /* cache only; never break the dispatcher */
      }
    }),
  )

  /* No agent/pre-step gate here: since DSH 44.7.0 the built-in session gate
     rejects steps for agents whose own session is archived, and the subagent
     runtime's archive admission covers managed ancestors. */

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && typeof systemPrompt.context === 'function') {
    let order = 60
    try {
      const delegated = systemPrompt.getContextOrder?.('SUBAGENT_DELEGATION')
      if (typeof delegated === 'number') order = delegated
    } catch {
      /* keep fallback order */
    }
    ctx.effect(() =>
      systemPrompt.context({
        name: 'team-janitor:hygiene',
        order,
        interpolate: false,
        text: ({ scope, toolSet, agent } = {}) => {
          /* `toolSet` is absent on request-time context refresh, so the gate is
             re-applied here: the sentence must never advertise a tool that
             this step's `when` excluded. */
          if (!canManageTeam(agent)) return ''
          const visible = definitions.filter((definition) => {
            try {
              return tools.get(definition.name, scope, toolSet) === definition
            } catch {
              return false
            }
          })
          if (visible.length === 0) return ''
          /* Sentence assembled from the tools that are actually visible, so a
             restricted tool set does not advertise tools the model cannot call. */
          const has = (toolName) => visible.some((definition) => definition.name === toolName)
          const parts = ['Team hygiene: close subagents you are done with']
          if (has('team_close')) parts.push('via team_close({ agents: ["<name>"] })')
          let sentence = parts.join(' ')
          if (has('team_restore')) sentence += '; closed members refuse new steps until team_restore'
          if (has('team_overview')) sentence += '; team_overview shows each member\'s outcome and last words'
          return `${sentence}.`
        },
      }),
    )
  }
}
