/**
 * dsh-team-janitor — browser half: red "cleared" marker in the Web UI.
 *
 * Registers at the sanctioned root subagent catalog footer slot
 * (`conversation.session.header.actions.subagent.footer` — the same position
 * the shared task board uses) and renders a red “已清除 / Cleared” section:
 * every loaded catalog entry whose session id is in the Workspace follow
 * stream's archived set. Catalog rows themselves expose no session id in
 * their DOM and there is no row-level slot in DSH 44.7.0, so the roster
 * below the tree is the stable, sanctioned place to make cleared members
 * visible to the user.
 *
 * Data sources (public client services only):
 *   - ctx.workspaces.list — Host-authoritative archived session id set
 *     (dsh-api-workspace-controller client half, live via workspace/follow);
 *   - useSessions(state.projectionsBySession) — the same subagentCatalog
 *     projections the lineage renderer reads, so coverage follows the levels
 *     the menu has loaded (expanding a branch adds its level).
 */

window.__ModuleLoader__.load({
  id: 'dsh-team-janitor',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useMemo } = React
    const h = React.createElement

    const NS = 'team-janitor'
    const dictionaries = {
      zh: { 'cleared.title': '已清除的子代理', 'cleared.badge': '已清除' },
      en: { 'cleared.title': 'Cleared subagents', 'cleared.badge': 'Cleared' },
      ja: { 'cleared.title': '削除済みのサブエージェント', 'cleared.badge': '削除済み' },
      de: { 'cleared.title': 'Entfernte Subagents', 'cleared.badge': 'Entfernt' },
      es: { 'cleared.title': 'Subagentes eliminados', 'cleared.badge': 'Eliminado' },
      fr: { 'cleared.title': 'Sous-agents supprimés', 'cleared.badge': 'Supprimé' },
      pt: { 'cleared.title': 'Subagentes removidos', 'cleared.badge': 'Removido' },
      ru: { 'cleared.title': 'Удалённые субагенты', 'cleared.badge': 'Очищен' },
    }

    const styles = {
      section: {
        margin: '2px 6px 6px',
        padding: '6px 8px 4px',
        borderTop: '1px solid rgba(128, 128, 128, 0.35)',
        fontSize: 12,
        lineHeight: '18px',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        margin: '0 0 4px',
        fontWeight: 600,
      },
      count: { fontWeight: 400, opacity: 0.65 },
      list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 },
      item: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chip: {
        flex: 'none',
        fontSize: 11,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 8,
        color: '#fff',
        background: '#e5484d',
      },
    }

    /**
     * Walk only this conversation's own subtree: start at `rootSessionId`'s
     * catalog and descend through loaded child catalogs. Catalogs of other
     * conversations are never visited, so one conversation's cleared marks
     * cannot leak into another's menu.
     */
    function collectCleared(projections, rootSessionId, archived) {
      const out = []
      const seen = new Set()
      const visited = new Set()
      const parents = [rootSessionId]
      while (parents.length > 0) {
        const parentId = parents.shift()
        if (parentId === undefined || visited.has(parentId)) continue
        visited.add(parentId)
        const entries = projections?.[parentId]?.values?.subagentCatalog
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          if (!entry || typeof entry.id !== 'string') continue
          if (!seen.has(entry.id)) {
            seen.add(entry.id)
            if (archived.has(entry.id)) {
              out.push({ id: entry.id, name: entry.label || entry.path || entry.name || entry.id })
            }
          }
          /* Descend only when that child's own catalog is loaded, so deeper
             cleared members stay reachable through unarchived intermediates. */
          if (projections?.[entry.id] !== undefined) parents.push(entry.id)
        }
      }
      return out
    }

    function ClearedRoster({ sessionId, useSessions, workspaces, t }) {
      const readArchived = () => {
        const ids = workspaces?.list?.getSnapshot?.()?.archivedSessionIds
        return Array.isArray(ids) ? ids : []
      }
      const [archived, setArchived] = useState(readArchived)
      useEffect(() => {
        const update = () => setArchived(readArchived())
        update()
        const unsubscribe = workspaces?.list?.subscribe?.(update)
        return typeof unsubscribe === 'function' ? unsubscribe : undefined
      }, [workspaces])
      const projections = useSessions((state) => state.projectionsBySession)
      const cleared = useMemo(
        () => collectCleared(projections, sessionId, new Set(archived)),
        [projections, sessionId, archived],
      )
      if (cleared.length === 0) return null
      return h(
        'section',
        { style: styles.section, 'data-team-janitor-cleared': true, role: 'group', 'aria-label': t('cleared.title') },
        h(
          'h3',
          { style: styles.header },
          h('span', { 'aria-hidden': true }, '🧹'),
          h('span', null, t('cleared.title')),
          h('span', { style: styles.count }, `· ${cleared.length}`),
        ),
        h(
          'ul',
          { style: styles.list },
          cleared.map((item) =>
            h(
              'li',
              { key: item.id, style: styles.item, title: item.id },
              h('span', { style: styles.name }, item.name),
              h('span', { style: styles.chip }, t('cleared.badge')),
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'workspaces'],
      apply(ctx) {
        if (!ctx.workspaces?.list || typeof ctx.workspaces.list.subscribe !== 'function') {
          /* Workspace state service unavailable — the marker cannot work, stay silent. */
          return
        }
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'team-janitor: dictionaries')
        ctx.slots.inject('conversation.session.header.actions.subagent.footer', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions.subagent.footer',
              id: 'team-janitor',
              locale: NS,
              inject: () => ({ workspaces: ctx.workspaces }),
            },
            ClearedRoster,
          ),
        )
      },
    }
  },
})
