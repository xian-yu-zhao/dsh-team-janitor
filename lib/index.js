/**
 * @local/team-janitor — team collaboration QoL for DSH.
 *
 * Lets the agent decide to close subagents whose work is done:
 *   - team_overview: compact tree roster with closed/running marks
 *   - team_close:    stop + archive specific descendants of the caller
 *   - team_sweep:    batch close idle descendants (preview by default)
 *   - team_restore:  reopen previously closed (archived) members
 *
 * Mechanism (public APIs only): closing = workspaceRegistry.archiveSession(
 * childId, { stopActivity: true }) — the workspace registry cancels the
 * session's own running turn (agent.cancel({kind:'user'})) and the subagent
 * runtime cancels running descendants (parent cause); the durable session
 * leaves the workspace sidebar and team_restore unarchives it. Later model
 * steps are blocked by DSH's built-in session gates (self-archived plus
 * managed-ancestor admission) — no plugin gate needed since DSH 44.7.0.
 * Capacity honesty: a normally finished subagent settles by itself and
 * frees its slot; archiving an idle member does not guarantee a freed slot
 * when parked input remains in its inbox (no public dispose/inbox-clear API).
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
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Residency of one session, derived from the agents registry:
 *   - running: a turn is in flight;
 *   - parked:  registered but no running turn — the member may still hold
 *              a capacity slot (e.g. parked input waiting in its inbox);
 *   - settled: absent from the registry — disposed, slot released.
 * When the agents service is unavailable nothing can be observed, so the
 * safe answer is 'parked' (possibly resident).
 */
function liveStatus(agents, id) {
  if (typeof agents?.get !== 'function') return 'parked'
  const agent = agents.get(id)
  if (!agent) return 'settled'
  return agent.status === 'running' ? 'running' : 'parked'
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
    if (agents?.get?.(entry.id)?.status === 'running') names.push(entry.path ?? entry.id)
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

function line(entry, excerpt) {
  const label = entry.label === undefined ? '' : ` — ${entry.label}`
  const session = entry.session === undefined || entry.session === entry.name ? '' : `  (session ${entry.session})`
  const last = excerpt === undefined ? '' : `  last: “${excerpt}”`
  return `${entry.name} [${entry.status}]${label}${session}${last}`
}

/** Defensive excerpt extraction for cached closing remarks. */
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
  /* Roster tokens are paid on every call: keep only enough to judge "used up?". */
  const LIMIT = 100
  return text.length > LIMIT ? `${text.slice(0, LIMIT - 1)}…` : text
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

function buildTools(ctx, lastWords) {
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

  /** One catalog row projected for the model, or undefined for one-shot children. */
  function project(entry, archived) {
    if (entry.kind === 'diagnostic') {
      return { name: entry.path ?? entry.id, session: entry.id, status: entry.reason ?? 'unavailable' }
    }
    if (entry.mode !== 'continuable') return undefined
    const closed = archived.has(entry.id)
    return {
      name: entry.path ?? entry.id,
      session: entry.id,
      status: closed ? 'closed' : liveStatus(agents, entry.id),
      label: entry.label,
    }
  }

  const overview = {
    name: 'team_overview',
    description:
      'Compact roster of your subagent tree: status closed (archived) | running (turn in flight) | parked (registered idle — may still hold a slot) | settled (disposed — slot released) | a read diagnostic reason. '
      + 'Rows may carry closing words to help judge whether a member is used up (suppress them with lastWords:false). '
      + 'closable lists your own closed-able descendants, parked first then settled; closing a settled member only archives it away from the sidebar. Closed rows refuse new steps until team_restore.',
    parameters: {
      type: 'object',
      properties: {
        lastWords: {
          type: 'boolean',
          description: 'Include each member’s cached closing words (default true). Pass false for a token-cheap roster when the tree is large.',
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
                status: { type: 'string', description: 'closed | running | parked (registered idle, slot may be held) | settled (disposed, slot released) | diagnostic reason' },
                label: { type: 'string' },
                last: { type: 'string', description: 'Closing words from the member’s last settled run; omitted while it is running.' },
              },
              required: ['name', 'session', 'status'],
            },
          },
          closable: { type: 'array', items: { type: 'string' } },
        },
        required: ['root', 'rows', 'closable'],
      },
      render: (_args, value) => {
        const lines = value.rows.map((row) => line(row, row.last))
        if (value.closable.length > 0) lines.push(`closable: ${value.closable.join(', ')}`)
        return TEXT(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('team_overview requires a calling agent (exec.agent was undefined)')
      const showLast = args.lastWords !== false
      const { root, entries, archived, under } = await snapshot(caller, exec.signal)
      const rows = [
        {
          name: root.name ?? 'lead',
          session: root.id,
          status: archived.has(root.id) ? 'closed' : liveStatus(agents, root.id),
          label: 'root agent',
          last: showLast && !archived.has(root.id) ? lastWords.get(root.id) : undefined,
        },
      ]
      const closable = []
      const settledNames = []
      for (const entry of entries) {
        const row = project(entry, archived)
        if (row === undefined) continue
        if (showLast && row.status !== 'running') row.last = lastWords.get(entry.id)
        rows.push(row)
        if (entry.id === caller.id) continue
        /* Rows cover the whole tree (useful context), but only the caller's own
           descendants are actually closeable — a sibling listed as closable
           would just be refused by team_close. */
        if (under.has(entry.id)) {
          if (row.status === 'parked') closable.push(row.name)
          else if (row.status === 'settled') settledNames.push(row.name)
        }
      }
      closable.push(...settledNames)
      return plain({ root: root.id, rows, closable })
    },
  }

  const close = {
    name: 'team_close',
    description:
      'Close used-up subagents you own: stop requested for their running work, sessions archived out of the sidebar, one settlement verdict per target (settled = slot released; still resident = parked inbox input may keep the slot). '
      + 'A closed member refuses new steps until team_restore — send_message does not wake it. '
      + 'Targets must be your own descendants; you cannot close yourself or the tree root. Pass names from team_overview/list_agents or session ids.',
    parameters: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 12,
          description: 'Names or session ids of the subagents to close, e.g. ["explorer"].',
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
          if (!entries.some((row) => row.id === targetId)) {
            plan.push({ agent: reference, outcome: 'unknown', detail: 'no member of this tree has that name or session id' })
            continue
          }
          if (targetId === caller.id) {
            plan.push({ agent: reference, outcome: 'refused', detail: 'you cannot close yourself' })
            continue
          }
          if (targetId === root.id) {
            plan.push({ agent: reference, outcome: 'refused', detail: 'the tree root cannot be closed' })
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

  const sweep = {
    name: 'team_sweep',
    description:
      'Close idle subagents in your subtree in one step. preview (default true) only lists candidates; preview:false closes them exactly like team_close. '
      + 'Running members are skipped unless includeRunning:true. Settlement is polled once for the whole batch; per-target failures are listed individually.',
    parameters: {
      type: 'object',
      properties: {
        preview: { type: 'boolean', description: 'true (default) lists candidates without closing; false closes them.' },
        includeRunning: { type: 'boolean', description: 'false (default) skips running agents; true closes them too, stopping their work.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          preview: { type: 'boolean' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, session: { type: 'string' }, status: { type: 'string' } },
              required: ['name', 'session', 'status'],
            },
          },
          closed: { type: 'integer' },
          settled: { type: 'integer', description: 'How many of the closed members left the agents registry during the poll (slot released). Omitted when the agents service is unavailable.' },
          resident: { type: 'integer', description: 'How many of the closed members were still resident when the poll budget ran out (slot may be retained by parked inbox input).' },
          unobserved: { type: 'integer', description: 'How many close outcomes were not observed because the call was cancelled.' },
          failures: { type: 'integer' },
          failuresDetail: {
            type: 'array',
            description: 'One row per failed close.',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, session: { type: 'string' }, error: { type: 'string' } },
              required: ['name', 'error'],
            },
          },
        },
        required: ['preview', 'candidates', 'closed', 'failures'],
      },
      render: (_args, value) => {
        const headline = value.preview
          ? `preview: ${value.candidates.length} candidate(s), nothing closed yet`
          : [
            `swept: closed ${value.closed}`,
            value.settled === undefined
              ? 'settlement not observed'
              : `${value.settled} settled / ${value.resident} still resident${value.unobserved ? ` / ${value.unobserved} unobserved` : ''}`,
            `failed ${value.failures}`,
          ].join(', ')
        const lines = [headline]
        for (const row of value.candidates) lines.push(line(row))
        for (const failure of value.failuresDetail ?? []) {
          const where = failure.session === undefined ? '' : ` (${failure.session})`
          lines.push(`failed: ${failure.name}${where} — ${failure.error}`)
        }
        if (value.preview && value.candidates.length > 0) lines.push('call again with preview=false to close them.')
        return TEXT(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('team_sweep requires a calling agent (exec.agent was undefined)')
      const preview = args.preview !== false
      const includeRunning = args.includeRunning === true
      const { entries, archived, under, service } = await snapshot(caller, exec.signal)
      if (!service) throw new Error('workspaceRegistry service is unavailable in this composition; cannot close sessions')
      const candidates = []
      for (const entry of entries) {
        if (entry.kind === 'diagnostic' || entry.mode !== 'continuable') continue
        if (!under.has(entry.id)) continue
        const closed = archived.has(entry.id)
        const status = liveStatus(agents, entry.id)
        const running = status === 'running'
        if (closed || (running && !includeRunning)) continue
        candidates.push({ entry, name: entry.path ?? entry.id, status })
      }
      const rows = candidates.map((item) => ({ name: item.name, session: item.entry.id, status: item.status }))
      if (preview) return plain({ preview: true, candidates: rows, closed: 0, failures: 0, failuresDetail: [] })
      let closed = 0
      const failuresDetail = []
      const archivedIds = []
      for (const item of candidates) {
        if (exec.signal?.aborted) {
          failuresDetail.push({ name: item.name, session: item.entry.id, error: 'call cancelled before this candidate was closed' })
          continue
        }
        try {
          await service.archiveSession(item.entry.id, { stopActivity: true })
          archived.add(item.entry.id)
          archivedIds.push(item.entry.id)
          closed += 1
        } catch (error) {
          failuresDetail.push({ name: item.name, session: item.entry.id, error: error instanceof Error ? error.message : String(error) })
        }
      }
      const settledMap = await settleMany(agents, archivedIds, exec.signal)
      let settled
      let resident
      let unobserved
      if (typeof agents?.get === 'function') {
        settled = 0
        resident = 0
        unobserved = 0
        for (const id of archivedIds) {
          const verdict = settledMap.get(id)
          if (verdict === true) settled += 1
          else if (verdict === 'cancelled') unobserved += 1
          else resident += 1
        }
      }
      return plain({ preview: false, candidates: rows, closed, settled, resident, unobserved, failures: failuresDetail.length, failuresDetail })
    },
  }

  const restore = {
    name: 'team_restore',
    description:
      'Reopen closed subagents: unarchive their sessions so they are visible and continuable again. Restoring makes the target resident and occupies a slot. '
      + 'With prompt the message is delivered right after unarchiving (restore-and-continue; a failed delivery does not undo the restore); without prompt no turn starts. '
      + 'Your subtree only; you cannot restore yourself, and non-continuable members cannot take a prompt.',
    parameters: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 12,
          description: 'Names or session ids of the closed subagents to restore.',
        },
        prompt: {
          type: 'string',
          description: 'Optional message delivered after unarchiving (restore-and-continue: the target resumes and occupies a slot). Omit to only restore visibility without starting a turn.',
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
      const { entries, archived, under } = await snapshot(caller, exec.signal)
      const results = []
      const seen = new Set()
      const wantsPrompt = typeof args.prompt === 'string' && args.prompt.length > 0
      for (const reference of args.agents) {
        if (exec.signal?.aborted) {
          results.push({ agent: reference, outcome: 'cancelled', detail: 'call cancelled before this target was handled' })
          continue
        }
        try {
          const targetId = await subagents.resolveName(caller, reference, exec.signal)
          const entry = entries.find((row) => row.id === targetId && row.kind !== 'diagnostic')
          const name = entry?.path ?? reference
          if (seen.has(targetId)) {
            results.push({ agent: name, session: targetId, outcome: 'duplicate', detail: 'already handled earlier in this call' })
            continue
          }
          seen.add(targetId)
          if (!entries.some((row) => row.id === targetId)) {
            results.push({ agent: reference, outcome: 'unknown', detail: 'no member of this tree has that name or session id' })
            continue
          }
          if (targetId === caller.id) {
            results.push({ agent: reference, outcome: 'refused', detail: 'you cannot restore yourself' })
            continue
          }
          if (!under.has(targetId)) {
            results.push({ agent: reference, outcome: 'refused', detail: 'not in your subtree' })
            continue
          }
          /* A one-shot/external child cannot be continued, and sendMessage has
             nothing to wake — restoring it with a prompt can only fail, so say
             so before touching the archive at all. */
          if (wantsPrompt && entry?.mode !== 'continuable') {
            results.push({ agent: name, session: targetId, outcome: 'refused', detail: 'not continuable: restore without prompt' })
            continue
          }
          if (!archived.has(targetId)) {
            results.push({ agent: name, session: targetId, outcome: 'not-closed' })
            continue
          }
          await service.unarchiveSession(targetId)
          archived.delete(targetId)
          /* Last words belong to the previous run; a restored member starts over. */
          lastWords.delete(targetId)
          if (wantsPrompt) {
            try {
              await subagents.sendMessage(caller, targetId, TEXT(args.prompt), { signal: exec.signal })
              results.push({ agent: name, session: targetId, outcome: 'restored', detail: 'restored; message accepted — a cold target resumes and occupies a slot' })
            } catch (deliveryError) {
              const why = deliveryError instanceof Error ? deliveryError.message : String(deliveryError)
              results.push({ agent: name, session: targetId, outcome: 'restored', detail: `restored but message failed: ${why}` })
            }
          } else {
            results.push({ agent: name, session: targetId, outcome: 'restored' })
          }
        } catch (error) {
          results.push({ agent: reference, outcome: 'failed', detail: error instanceof Error ? error.message : String(error) })
        }
      }
      return plain({ results })
    },
  }

  return [overview, close, sweep, restore]
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

  const lastWords = new Map()
  /* Bounded derived cache: the roster only ever needs recent members, and a
     long-lived session can see thousands of subagent runs (FIFO eviction). */
  const LAST_WORDS_LIMIT = 256
  const definitions = buildTools(ctx, lastWords)
  for (const definition of definitions) {
    ctx.effect(() => tools.register(definition))
  }

  /** Cache each member's closing words when its run settles (process-local derived cache). */
  ctx.effect(() =>
    ctx.on?.('subagent/end', (info) => {
      try {
        if (!info || typeof info.id !== 'string') return
        /* `||` on purpose: an empty lastAssistantMessage must not mask output. */
        const excerpt = excerptOf(info.lastAssistantMessage) || excerptOf(info.output)
        if (excerpt) {
          lastWords.delete(info.id)
          lastWords.set(info.id, excerpt)
          while (lastWords.size > LAST_WORDS_LIMIT) {
            const oldest = lastWords.keys().next().value
            if (oldest === undefined) break
            lastWords.delete(oldest)
          }
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
        text: ({ scope, toolSet } = {}) => {
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
          if (has('team_sweep')) parts.push(`${has('team_close') ? 'or ' : 'via '}team_sweep (preview first, then preview:false)`)
          let sentence = parts.join(' ')
          if (has('team_restore')) sentence += '; closed members refuse new steps until team_restore'
          if (has('team_overview')) sentence += '; team_overview shows status and closing words'
          return `${sentence}.`
        },
      }),
    )
  }
}
