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
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt']

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Live turn status of one session, or undefined when not resident. */
function liveStatus(agents, id) {
  return agents?.get?.(id)?.status === 'running' ? 'running' : 'inactive'
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

function line(entry, excerpt) {
  const label = entry.label === undefined ? '' : ` — ${entry.label}`
  const session = entry.session === undefined ? '' : `  (session ${entry.session})`
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
  return text.length > 140 ? `${text.slice(0, 139)}…` : text
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
      'Compact roster of your subagent tree with closure state: status is running, inactive, closed (archived), or a read diagnostic. '
      + 'Rows may carry the member’s closing words from its last settled run, which helps judge whether it is used up. '
      + 'inactive means only that no turn is running right now — the member may still be resident. '
      + 'Use it before deciding whom to close: continuable rows marked inactive are closable with team_close; closed rows refuse new steps until team_restore.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
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
                session: { type: 'string' },
                status: { type: 'string' },
                label: { type: 'string' },
                last: { type: 'string' },
              },
              required: ['name', 'session', 'status'],
            },
          },
          closable: { type: 'array', items: { type: 'string' } },
        },
        required: ['root', 'rows', 'closable'],
      },
      render: (_args, value) => {
        const lines = [`root ${value.root}`]
        for (const row of value.rows) lines.push(line(row, row.last))
        lines.push(`closable now: ${value.closable.length ? value.closable.join(', ') : '(none)'}`)
        return TEXT(lines.join('\n'))
      },
    },
    async execute(_args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('team_overview requires a calling agent (exec.agent was undefined)')
      const { root, entries, archived } = await snapshot(caller, exec.signal)
      const rows = [
        { name: 'lead', session: root.id, status: archived.has(root.id) ? 'closed' : liveStatus(agents, root.id), label: 'root agent', last: lastWords.get(root.id) },
      ]
      const closable = []
      for (const entry of entries) {
        const row = project(entry, archived)
        if (row === undefined) continue
        row.last = lastWords.get(entry.id)
        rows.push(row)
        if (row.status === 'inactive' && entry.id !== caller.id) closable.push(row.name)
      }
      return plain({ root: root.id, rows, closable })
    },
  }

  const close = {
    name: 'team_close',
    description:
      'Close used-up subagents you own: stop their running work (their running descendants stop too) and archive their sessions so they leave the workspace sidebar. '
      + 'A closed member refuses new model steps until restored, so send_message to it will not wake it back up. '
      + 'Archiving stops activity but does not guarantee a freed capacity slot: a member whose inbox still holds parked input may stay resident (no public dispose or inbox-clear API exists). '
      + 'Each target must be your descendant (direct child or deeper); you cannot close yourself or the tree root. '
      + 'Closed members keep their history and can be reopened with team_restore. Pass names from team_overview/list_agents or session ids.',
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
                outcome: { type: 'string' },
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
      if (!caller) throw new Error('team_close requires a calling agent (exec.agent was undefined)')
      const service = registry()
      if (!service) throw new Error('workspaceRegistry service is unavailable in this composition; cannot close sessions')
      const { root, entries, archived, under } = await snapshot(caller, exec.signal)
      const results = []
      for (const reference of args.agents) {
        try {
          const targetId = await subagents.resolveName(caller, reference, exec.signal)
          const entry = entries.find((row) => row.id === targetId && row.kind !== 'diagnostic')
          const name = entry?.path ?? reference
          if (targetId === caller.id) {
            results.push({ agent: reference, outcome: 'refused', detail: 'you cannot close yourself' })
            continue
          }
          if (targetId === root.id) {
            results.push({ agent: reference, outcome: 'refused', detail: 'the tree root cannot be closed' })
            continue
          }
          if (!under.has(targetId)) {
            results.push({ agent: reference, outcome: 'refused', detail: 'not one of your descendants' })
            continue
          }
          if (archived.has(targetId)) {
            results.push({ agent: name, session: targetId, outcome: 'already-closed' })
            continue
          }
          const stopped = runningNames(entries, agents, idsUnder(entries, root.id, targetId))
          await service.archiveSession(targetId, { stopActivity: true })
          archived.add(targetId)
          const notes = ['archived; activity stopped']
          if (stopped.length > 0) notes.push(`stopped running descendants: ${stopped.join(', ')}`)
          notes.push('if its inbox held parked input, its slot may remain occupied')
          results.push({
            agent: name,
            session: targetId,
            outcome: 'closed',
            detail: notes.join('; '),
          })
        } catch (error) {
          results.push({ agent: reference, outcome: 'failed', detail: error instanceof Error ? error.message : String(error) })
        }
      }
      return plain({ results })
    },
  }

  const sweep = {
    name: 'team_sweep',
    description:
      'Close idle subagents in your subtree in one step. Default preview=true only lists the candidates (continuable, not running, not closed); '
      + 'preview=false closes them exactly like team_close: archived, activity stopped — a member whose inbox still holds parked input may stay resident and keep its slot. '
      + 'Running agents are left out unless includeRunning=true.',
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
          failures: { type: 'integer' },
        },
        required: ['preview', 'candidates', 'closed', 'failures'],
      },
      render: (_args, value) => {
        const lines = [value.preview ? `preview: ${value.candidates.length} candidate(s), nothing closed yet` : `swept: closed ${value.closed}, failed ${value.failures}`]
        for (const row of value.candidates) lines.push(line(row))
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
        const running = agents?.get?.(entry.id)?.status === 'running'
        if (closed || (running && !includeRunning)) continue
        candidates.push({ entry, name: entry.path ?? entry.id, running })
      }
      const rows = candidates.map((item) => ({ name: item.name, session: item.entry.id, status: item.running ? 'running' : 'inactive' }))
      if (preview) return plain({ preview: true, candidates: rows, closed: 0, failures: 0 })
      let closed = 0
      let failures = 0
      for (const item of candidates) {
        try {
          await service.archiveSession(item.entry.id, { stopActivity: true })
          archived.add(item.entry.id)
          closed += 1
        } catch {
          failures += 1
        }
      }
      return plain({ preview: false, candidates: rows, closed, failures })
    },
  }

  const restore = {
    name: 'team_restore',
    description:
      'Reopen previously closed subagents: unarchive their sessions so they become visible, step again, and can receive send_message. '
      + 'Only members of your subtree can be restored; restoring does not resume a turn.',
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
                outcome: { type: 'string' },
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
      for (const reference of args.agents) {
        try {
          const targetId = await subagents.resolveName(caller, reference, exec.signal)
          const entry = entries.find((row) => row.id === targetId && row.kind !== 'diagnostic')
          const name = entry?.path ?? reference
          if (!under.has(targetId) && targetId !== caller.id) {
            results.push({ agent: reference, outcome: 'refused', detail: 'not in your subtree' })
            continue
          }
          if (!archived.has(targetId)) {
            results.push({ agent: name, session: targetId, outcome: 'not-closed' })
            continue
          }
          await service.unarchiveSession(targetId)
          archived.delete(targetId)
          results.push({ agent: name, session: targetId, outcome: 'restored' })
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
  if (!subagents || typeof subagents.listDescendants !== 'function' || !tools) {
    ctx.logger?.warn?.('[team-janitor] subagents/tools services unavailable; plugin stays idle')
    return
  }

  const lastWords = new Map()
  const definitions = buildTools(ctx, lastWords)
  for (const definition of definitions) {
    ctx.effect(() => tools.register(definition))
  }

  /** Cache each member's closing words when its run settles (process-local derived cache). */
  ctx.effect(() =>
    ctx.on?.('subagent/end', (info) => {
      try {
        if (!info || typeof info.id !== 'string') return
        const excerpt = excerptOf(info.lastAssistantMessage ?? info.output)
        if (excerpt) lastWords.set(info.id, excerpt)
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
          return [
            'Team hygiene: when a subagent in your subtree is done and you will not need it again, close it with team_close({ agents: ["<name>"] }) '
            + 'or sweep idle ones with team_sweep (preview first). Closing stops its running work, archives its session, and blocks new steps until '
            + 'team_restore reopens it. team_overview shows who is closed and what each member last said.',
          ].join('\n')
        },
      }),
    )
  }
}
