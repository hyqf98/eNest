/**
 * schemaTree.js — 连接 / 表 / 控制台会话 / 历史（左侧栏）
 * 折叠：图标轨；展开：列表。操作走右键；连接按驱动类型着色区分
 */
import { DbHost, toast, hostLag } from './api.js'
import { state, getConnection } from './store.js'
import { openCtxMenu } from './ctxMenu.js'
import { setTip } from './tips.js'

const DRIVER_LABEL = {
  mysql: 'MySQL',
  sqlite: 'SQLite',
  postgres: 'PG',
  timescale: 'Timescale',
  influxdb: 'Influx',
  tdengine: 'TDengine'
}

/** 驱动短名 + CSS 修饰 class，连接列表一眼区分类型 */
export function driverMeta(d) {
  const key = String(d || '').toLowerCase()
  const label = DRIVER_LABEL[key] || key || 'DB'
  return { label, cls: `d-${key.replace(/[^a-z0-9]/g, '')}` }
}

const RAIL_TABS = [
  { id: 'sessions', icon: '☰', label: '会话' },
  { id: 'connections', icon: '⚡', label: '连接' },
  { id: 'tree', icon: '▦', label: '表' },
  { id: 'history', icon: '⏱', label: '历史' }
]

export function driverLabel(d) {
  return driverMeta(d).label
}

export class SidePanel {
  constructor(root, handlers = {}) {
    this.root = root
    this.h = handlers
    this.expanded = new Set()
    this.treeData = new Map()
    this.tab = state.ui.leftTab || 'sessions'
    this.collapsed = !!state.ui.sidebarCollapsed
    this._build()
    this._bind()
  }

  setCollapsed(v) {
    this.collapsed = !!v
    this.render()
  }

  _build() {
    this.root.innerHTML = `
      <div class="side-shell">
        <nav class="side-rail" data-el="rail"></nav>
        <div class="side-body" data-el="body">
          <div class="side-tabs">
            ${RAIL_TABS.map(
              (t) => `<button type="button" data-tab="${t.id}">${t.label}</button>`
            ).join('')}
          </div>
          <div class="side-toolbar">
            <input class="side-search" data-el="search" placeholder="搜索…" />
            <button type="button" class="btn icon" data-act="side-action" title="操作" aria-label="操作">＋</button>
          </div>
          <div class="side-list" data-el="list"></div>
        </div>
      </div>
    `
    this.el = {
      rail: this.root.querySelector('[data-el=rail]'),
      body: this.root.querySelector('[data-el=body]'),
      list: this.root.querySelector('[data-el=list]'),
      search: this.root.querySelector('[data-el=search]'),
      action: this.root.querySelector('[data-act=side-action]')
    }
  }

  _bind() {
    this.root.querySelectorAll('.side-tabs [data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => this.setTab(btn.dataset.tab))
    })
    this.el.search.addEventListener('input', () => this.render())
    this.el.action.addEventListener('click', (e) => {
      if (this.tab === 'connections') {
        openCtxMenu(
          e,
          [
            ['new', '新建连接'],
            ['export-all', '导出全部配置']
          ],
          (k) => {
            if (k === 'new') this.h.onSideAction?.('connections')
            else if (k === 'export-all') this.h.onExportConnections?.(state.connections)
          }
        )
        return
      }
      if (this.tab === 'sessions') {
        openCtxMenu(
          e,
          [
            ['new', '新建会话'],
            ['export-all', '导出全部会话']
          ],
          (k) => {
            if (k === 'new') this.h.onSideAction?.('sessions')
            else if (k === 'export-all') this.h.onExportSessions?.(state.sessions)
          }
        )
        return
      }
      if (this.tab === 'history') {
        openCtxMenu(
          e,
          [
            ['export', '导出历史'],
            ['clear', '清空历史', { danger: true }]
          ],
          (k) => {
            if (k === 'export') this.h.onExportHistory?.(state.queryHistory)
            else if (k === 'clear') this.h.onSideAction?.('history')
          }
        )
        return
      }
      this.h.onSideAction?.(this.tab)
    })
    this.root.addEventListener('click', (e) => {
      const railBtn = e.target.closest('.side-rail [data-tab]')
      if (!railBtn) return
      this.setTab(railBtn.dataset.tab)
      if (this.collapsed) this.h.onExpandRequest?.()
    })
  }

  setTab(tab) {
    this.tab = tab
    this.root.querySelectorAll('.side-tabs [data-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab)
    })
    this.root.querySelectorAll('.side-rail [data-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab)
    })
    try {
      this.h.onTabChange?.(tab)
    } catch {
      /* ignore */
    }
    this.render()
  }

  _renderRail() {
    this.el.rail.innerHTML = RAIL_TABS.map(
      (t) =>
        `<button type="button" class="rail-btn${this.tab === t.id ? ' active' : ''}" data-tab="${t.id}" title="${t.label}" aria-label="${t.label}" data-tip="${t.label}">${t.icon}</button>`
    ).join('')
    this._syncActionTitle()
  }

  _syncActionTitle() {
    const map = {
      sessions: '新建会话 / 导出',
      connections: '新建连接 / 导出',
      tree: '刷新表列表',
      history: '导出 / 清空历史'
    }
    const label = map[this.tab] || '操作'
    if (this.el.action) setTip(this.el.action, label)
  }

  render() {
    this._renderRail()
    this.el.body.hidden = this.collapsed
    this.root.classList.toggle('is-collapsed', this.collapsed)
    if (this.collapsed) return
    const q = (this.el.search.value || '').trim().toLowerCase()
    this.root.querySelectorAll('.side-tabs [data-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === this.tab)
    })
    if (this.tab === 'connections') this._renderConnections(q)
    else if (this.tab === 'tree') this._renderTree(q)
    else if (this.tab === 'history') this._renderHistory(q)
    else this._renderSessions(q)
  }

  _renderSessions(q) {
    const list = state.sessions.filter((s) => !q || (s.name || '').toLowerCase().includes(q))
    this.el.action.textContent = '＋'
    setTip(this.el.action, '新建会话')
    if (!list.length) {
      this.el.list.innerHTML = `<div class="empty">暂无会话</div>`
      return
    }
    const sorted = [...list].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt
    )
    this.el.list.innerHTML = sorted
      .map((s) => {
        const conn = getConnection(s.connectionId)
        const dirty = (s.editors || []).some((e) => e.dirty)
        return `<div class="side-item session${s.id === state.activeSessionId ? ' active' : ''}${s.pinned ? ' pinned' : ''}" data-id="${s.id}">
          <div class="side-item-main">
            <div class="side-title">${s.pinned ? '· ' : ''}${esc(s.name)}${dirty ? ' *' : ''}</div>
            <div class="side-sub">${esc(conn?.name || '未连接')}</div>
          </div>
        </div>`
      })
      .join('')
    this._bindSessionItems()
  }

  _bindSessionItems() {
    this.el.list.querySelectorAll('.side-item.session').forEach((el) => {
      const id = el.dataset.id
      el.addEventListener('click', () => this.h.onSelectSession?.(id))
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        openCtxMenu(
          e,
          [
            ['open', '打开'],
            ['rename', '重命名'],
            ['pin', '置顶 / 取消'],
            ['dup', '复制'],
            ['export', '导出会话'],
            'sep',
            ['del', '删除', { danger: true }]
          ],
          (k) => this.h.onSessionAction?.(id, k)
        )
      })
    })
  }

  _renderConnections(q) {
    if (this.el.action) {
      this.el.action.textContent = '＋'
      setTip(this.el.action, '新建连接')
    }
    const conns = state.connections.filter(
      (c) =>
        !q ||
        [c.name, c.host, c.database, c.username, c.driver]
          .filter(Boolean)
          .some((x) => String(x).toLowerCase().includes(q))
    )
    if (!conns.length) {
      this.el.list.innerHTML = `<div class="empty">暂无连接</div>`
      return
    }
    const groups = new Map()
    for (const c of conns) {
      const env = c.env || 'default'
      if (!groups.has(env)) groups.set(env, [])
      groups.get(env).push(c)
    }
    let html = ''
    for (const [env, arr] of groups) {
      html += `<div class="side-group">${esc(env === 'default' ? '默认' : env)}</div>`
      html += arr
        .map(
          (c) => {
            const dm = driverMeta(c.driver)
            return `<div class="side-item conn${c.id === state.selectedConnectionId ? ' active' : ''}" data-id="${c.id}" title="${esc(c.name || c.id)}">
          <div class="side-item-main">
            <div class="side-title">${c.favorite ? '★ ' : ''}${esc(c.name || c.id)}</div>
            <div class="side-sub">
              <span class="badge xs driver ${dm.cls}">${dm.label}</span>
              ${c.readOnly ? '<span class="badge xs warn">只读</span>' : ''}
              ${esc([c.host, c.port, c.database || c.sqlitePath].filter(Boolean).join(' · '))}
            </div>
          </div>
        </div>`
          }
        )
        .join('')
    }
    this.el.list.innerHTML = html
    this.el.list.querySelectorAll('.side-item.conn').forEach((el) => {
      const id = el.dataset.id
      el.addEventListener('click', () => this.h.onSelectConnection?.(id))
      el.addEventListener('dblclick', () => this.h.onConnectionAction?.(id, 'connect'))
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        this.h.onConnectionContext?.(id, e)
      })
    })
  }

  _renderHistory(q) {
    this.el.action.textContent = '⌫'
    setTip(this.el.action, '清空历史')
    const list = state.queryHistory
      .filter((h) => !q || (h.sql || '').toLowerCase().includes(q))
      .slice(0, 200)
    if (!list.length) {
      this.el.list.innerHTML = `<div class="empty">暂无查询历史</div>`
      return
    }
    this.el.list.innerHTML = list
      .map(
        (h) => `<div class="side-item hist${h.error ? ' error' : ''}" data-id="${h.id}" title="${esc(h.sql)}">
        <div class="side-item-main">
          <div class="side-title sql-preview">${esc((h.sql || '').slice(0, 80))}</div>
          <div class="side-sub">${new Date(h.ts).toLocaleString()} · ${h.durationMs ?? '-'}ms · ${h.rowCount ?? '-'} 行</div>
        </div>
      </div>`
      )
      .join('')
    this.el.list.querySelectorAll('.side-item.hist').forEach((el) => {
      el.addEventListener('dblclick', () => this.h.onHistoryInsert?.(el.dataset.id))
      el.addEventListener('click', () => this.h.onHistorySelect?.(el.dataset.id))
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        openCtxMenu(
          e,
          [
            ['insert', '插入编辑器'],
            ['copy', '复制 SQL'],
            ['export', '导出历史'],
            'sep',
            ['clear', '清空历史', { danger: true }]
          ],
          (k) => {
            if (k === 'insert') this.h.onHistoryInsert?.(el.dataset.id)
            else if (k === 'copy') this.h.onHistoryCopy?.(el.dataset.id)
            else if (k === 'export') this.h.onExportHistory?.(state.queryHistory)
            else if (k === 'clear') this.h.onSideAction?.('history')
          }
        )
      })
    })
  }

  _renderTree(q) {
    this.el.action.textContent = '⟳'
    setTip(this.el.action, '刷新表列表')
    const connId =
      state.selectedConnectionId ||
      state.sessions.find((s) => s.id === state.activeSessionId)?.connectionId
    const conn = getConnection(connId)
    if (!conn) {
      this.el.list.innerHTML = `<div class="empty">请先选择连接</div>`
      return
    }
    const rootKey = `conn:${conn.id}`
    const children = this.treeData.get(rootKey)
    if (!children) {
      this.el.list.innerHTML = `<div class="empty">加载中…</div>`
      this.loadTreeRoot(conn).then(() => this.render())
      return
    }
    this.el.list.innerHTML =
      `<div class="tree-root"><span class="badge xs driver ${driverMeta(conn.driver).cls}">${driverMeta(conn.driver).label}</span> ${esc(conn.name)}</div>` +
      this._renderNodes(children, q, 0, conn)
    this._bindTreeNodes(conn)
  }

  _renderNodes(nodes, q, depth, conn) {
    return (nodes || [])
      .filter(
        (n) =>
          !q ||
          n.label.toLowerCase().includes(q) ||
          (n.type === 'column' && String(n.detail || '').toLowerCase().includes(q))
      )
      .map((n) => {
        const key = n.key
        const open = this.expanded.has(key)
        const kids = this.treeData.get(key)
        const arrow =
          n.expandable === false
            ? '<span class="tree-arrow blank"></span>'
            : `<span class="tree-arrow${open ? ' open' : ''}" data-toggle="${key}">▸</span>`
        let html = `<div class="tree-node" data-key="${key}" data-type="${n.type}" style="padding-left:${8 + depth * 12}px">
          ${arrow}<span class="tree-label">${esc(n.label)}</span>
          ${n.detail ? `<span class="tree-detail">${esc(n.detail)}</span>` : ''}
        </div>`
        if (open && kids) html += this._renderNodes(kids, q, depth + 1, conn)
        if (open && !kids)
          html += `<div class="empty sm" style="padding-left:${24 + depth * 12}px">加载中…</div>`
        return html
      })
      .join('')
  }

  _bindTreeNodes(conn) {
    this.el.list.querySelectorAll('.tree-arrow[data-toggle]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation()
        const key = el.dataset.toggle
        if (this.expanded.has(key)) this.expanded.delete(key)
        else {
          this.expanded.add(key)
          if (!this.treeData.has(key)) {
            const node = this._findNode(key)
            await this.loadTreeChildren(conn, node)
          }
        }
        this.render()
      })
    })
    this.el.list.querySelectorAll('.tree-node').forEach((el) => {
      el.addEventListener('dblclick', () => {
        const node = this._findNode(el.dataset.key)
        if (node && (node.type === 'table' || node.type === 'view' || node.type === 'measurement')) {
          this.h.onOpenTable?.(node, conn)
        }
      })
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const node = this._findNode(el.dataset.key)
        if (node) this.h.onTreeContext?.(node, conn, e)
      })
    })
  }

  _findNode(key) {
    for (const nodes of this.treeData.values()) {
      const stack = [...(nodes || [])]
      while (stack.length) {
        const n = stack.pop()
        if (n.key === key) return n
        const kids = this.treeData.get(n.key)
        if (kids) stack.push(...kids)
      }
    }
    return null
  }

  sessionKeyFor(conn) {
    return state.runtime.sessionKeys.get(conn.id) || conn.id
  }

  async loadTreeRoot(conn) {
    const key = `conn:${conn.id}`
    const sessionKey = this.sessionKeyFor(conn)
    try {
      const res = await DbHost.schema.tree({
        sessionKey,
        connectionId: conn.id,
        node: { type: 'root' }
      })
      const nodes = normalizeTreeNodes(res, conn.id, '')
      this.treeData.set(key, nodes)
    } catch (e) {
      try {
        const tables = await DbHost.schema.tables({ sessionKey, connectionId: conn.id })
        const list = Array.isArray(tables) ? tables : tables?.tables || []
        this.treeData.set(
          key,
          list.map((t) => ({
            key: `t:${conn.id}:${t.name}`,
            label: t.name,
            type: t.type || 'table',
            detail: t.comment || t.type || '',
            data: t,
            expandable: true
          }))
        )
      } catch (e2) {
        this.treeData.set(key, [
          {
            key: `err:${conn.id}`,
            label: hostLag(e2) ? '功能未就绪' : String(e2.message || e2),
            type: 'error',
            expandable: false
          }
        ])
      }
    }
  }

  async loadTreeChildren(conn, node) {
    if (!node) return
    const sessionKey = this.sessionKeyFor(conn)
    try {
      const res = await DbHost.schema.tree({
        sessionKey,
        connectionId: conn.id,
        node: {
          type: node.type,
          database: node.database,
          schema: node.schema,
          table: node.name || node.label,
          data: node.data
        }
      })
      const nodes = normalizeTreeNodes(res, conn.id, node.key)
      this.treeData.set(node.key, nodes)
    } catch (e) {
      if (node.type === 'table' || node.type === 'view') {
        try {
          const cols = await DbHost.schema.columns({
            sessionKey,
            connectionId: conn.id,
            database: node.database,
            schema: node.schema,
            table: node.name || node.label
          })
          const list = Array.isArray(cols) ? cols : cols?.columns || []
          this.treeData.set(
            node.key,
            list.map((c) => ({
              key: `${node.key}:c:${c.name}`,
              label: c.name,
              type: 'column',
              detail: [c.type || c.dataType, c.pk || c.primaryKey ? 'PK' : null, c.comment]
                .filter(Boolean)
                .join(' · '),
              expandable: false
            }))
          )
          this.h.onCatalogPatch?.(conn.id, node.name || node.label, list)
        } catch (e2) {
          this.treeData.set(node.key, [
            {
              key: `${node.key}:err`,
              label: hostLag(e2) ? '功能未就绪' : String(e2.message || e2),
              type: 'error',
              expandable: false
            }
          ])
        }
      } else {
        this.treeData.set(node.key, [
          {
            key: `${node.key}:err`,
            label: hostLag(e) ? '功能未就绪' : String(e.message || e),
            type: 'error',
            expandable: false
          }
        ])
      }
    }
  }

  async refreshTree(conn) {
    this.treeData.clear()
    this.expanded.clear()
    await this.loadTreeRoot(conn)
    this.render()
    if (conn) toast('表列表已刷新', 'success')
  }
}

function normalizeTreeNodes(res, connId, parentKey) {
  let list = []
  if (Array.isArray(res)) list = res
  else if (Array.isArray(res?.nodes)) list = res.nodes
  else if (Array.isArray(res?.children)) list = res.children
  else if (Array.isArray(res?.items)) list = res.items
  else if (res && typeof res === 'object') {
    for (const [k, v] of Object.entries(res)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        list = v.map((x) => ({ ...x, _kind: k }))
        break
      }
    }
  }
  return list.map((n) => {
    const type = n.type || n._kind || n.kind || 'node'
    const label = n.name || n.label || n.table || String(n)
    return {
      key: `${parentKey || connId}:${type}:${label}`,
      label,
      type,
      detail: n.comment || n.detail || n.dataType || n.type || '',
      database: n.database,
      schema: n.schema,
      name: n.name || n.table || label,
      data: n,
      expandable: n.expandable !== false && type !== 'column' && type !== 'error'
    }
  })
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export { esc }
