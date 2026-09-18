/**
 * main.js — 数据库插件入口
 * 数据：enest.storage KV；密钥：enest.vault.set → secretRef
 * Host：db.* Spec 方法名；宿主滞后 try/catch → toast/状态
 * UI：顶栏连接 chip + ⋯；侧栏可折叠图标轨；FAB 执行；右键/菜单收纳次要操作
 */
import {
  api,
  applyShellTheme,
  registerPluginSettings,
  setFollowShellTheme,
  DbHost,
  Vault,
  toast,
  notify,
  setTitle,
  hostLag,
  toConnectionInput,
  sessionKeyOf,
  StorageKeys,
  saveTextFile,
  clipboardWrite
} from './api.js'
import {
  state,
  loadAll,
  persistNow,
  flushPendingPersist,
  activeSession,
  activeEditor,
  getConnection,
  upsertConnection,
  removeConnection,
  duplicateConnection,
  createSession,
  createEditorTab,
  setActiveSession,
  renameSession,
  togglePinSession,
  deleteSession,
  duplicateSession,
  closeEditorTab,
  updateSessionEditorSql,
  saveSessionsImmediate,
  pushHistory,
  getResultState,
  setUiPref,
  uid
} from './store.js'
import { SqlEditor } from './editor.js'
import { ResultGrid, quoteIdent } from './resultGrid.js'
import {
  setCatalog,
  invalidateCatalog,
  detectDdl,
  kindMeta,
  warmCatalogFromHost,
  patchCatalogTable,
  dialectOf
} from './completion.js'
import { SidePanel, driverLabel } from './schemaTree.js'
import {
  createImportWizard,
  exportResult,
  copyResult,
  exportConnections,
  exportSessions,
  exportHistory
} from './importExport.js'
import { detectDangerousSql } from './tokenizer.js'
import { openCtxMenu, closeCtxMenu } from './ctxMenu.js'
import { bindIconTips, setTip } from './tips.js'

const $ = (sel) => document.querySelector(sel)
const dom = {
  app: $('#app'),
  side: $('#side'),
  sideToggle: $('#side-toggle'),
  topMore: $('#top-more'),
  editorTabs: $('#editor-tabs'),
  toolbar: $('#toolbar'),
  editorHost: $('#editor-host'),
  results: $('#results'),
  statusbar: $('#statusbar'),
  rightPanel: $('#right-panel'),
  modalRoot: $('#modal-root'),
  toastLocal: $('#local-toast'),
  fabRun: $('#fab-run'),
  fabMore: $('#fab-more')
}

let editor = null
let grid = null
let side = null
let rightMode = 'changes'

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function currentSession() {
  return activeSession()
}
function currentEditor() {
  return activeEditor()
}
function currentConnection() {
  const s = currentSession()
  return s ? getConnection(s.connectionId) : getConnection(state.selectedConnectionId)
}
function currentSessionKey() {
  const conn = currentConnection()
  if (!conn) return ''
  return (
    state.runtime.sessionKeys.get(conn.id) ||
    sessionKeyOf(conn.id, currentSession()?.database || conn.database)
  )
}
function currentDialect() {
  const conn = currentConnection()
  return conn?.dialect || conn?.driver || 'mysql'
}
function currentResultState() {
  const ed = currentEditor()
  return ed ? getResultState(ed.id) : null
}

function menuItems(pairs) {
  const out = []
  for (const it of pairs) {
    if (!it || (Array.isArray(it) && !it[0])) continue
    if (it === 'sep') {
      if (!out.length || out[out.length - 1] === 'sep') continue
      out.push(it)
      continue
    }
    out.push(it)
  }
  while (out.length && out[out.length - 1] === 'sep') out.pop()
  return out
}

/* ───────────── boot ───────────── */

async function boot() {
  bindIconTips()
  await registerPluginSettings()
  await applyShellTheme()
  try {
    await setTitle('数据库')
  } catch {
    /* ignore */
  }

  editor = new SqlEditor(dom.editorHost, {
    onChange: (sql, cursor) => {
      const ed = currentEditor()
      if (!ed) return
      updateSessionEditorSql(ed, sql, cursor)
      renderEditorTabs()
      syncDockFromGrid()
    },
    onExecute: (opts) => void execute(opts),
    onExecuteAll: () => void execute({ mode: 'all' }),
    onSave: () => void saveSessionNow(),
    getSessionKey: () => currentSessionKey(),
    getDialect: () => currentDialect(),
    getCompletionScope: () => {
      const conn = currentConnection()
      const s = currentSession()
      return {
        database: s?.database || conn?.database,
        schema: s?.schema || conn?.schema,
        usageBoost: state.completionUsage,
        autoAliasAfterTable: state.ui.autoAliasAfterTable !== false
      }
    }
  })

  grid = new ResultGrid(dom.results, {
    onCommit: () => void commitChanges(),
    onRevert: () => {
      syncDockFromGrid()
      renderRightPanel()
    },
    onExport: () => openExportMenu(),
    onExportCsv: () => {
      const { cols, rows } = grid.getExportData(grid.selectedRows.size ? 'selected' : 'all')
      void exportResult('csv', cols, rows, grid.tableRef, state.ui)
    },
    onImport: () => openImportWizard(),
    onGenerateSql: (kind) => showSqlPreview(kind),
    onSelectionChange: () => {
      syncDockFromGrid()
      renderRightPanel()
    },
    onRefresh: () => void execute({ mode: 'current' })
  })

  side = new SidePanel(dom.side, {
    onSideAction: (tab) => void onSideAction(tab),
    onSelectSession: (id) => selectSession(id),
    onSessionAction: (id, act) => void onSessionAction(id, act),
    onSelectConnection: (id) => {
      state.selectedConnectionId = id
      side.render()
    },
    onConnectionAction: (id, act) => void onConnectionAction(id, act),
    onConnectionContext: (id, ev) => void connectionContext(id, ev),
    onExportConnections: (list) => void exportConnections(list),
    onExportSessions: (list) => void exportSessions(list),
    onExportHistory: (list) => void exportHistory(list),
    onTabChange: (tab) => setUiPref('leftTab', tab),
    onHistoryInsert: (id) => insertHistory(id),
    onHistorySelect: (id) => {
      const h = state.queryHistory.find((x) => x.id === id)
      if (h) showLocalToast(h.error || h.sql.slice(0, 120))
    },
    onHistoryCopy: async (id) => {
      const h = state.queryHistory.find((x) => x.id === id)
      if (!h) return
      await clipboardWrite(h.sql)
      showLocalToast('已复制 SQL', 'success')
    },
    onExpandRequest: () => setSidebarCollapsed(false),
    onOpenTable: (node, conn) => void openTableData(node, conn),
    onTreeContext: (node, conn, ev) => void treeContext(node, conn, ev),
    onCatalogPatch: (connId, tableName, columns) => {
      const sk = state.runtime.sessionKeys.get(connId)
      if (!sk || !tableName) return
      patchCatalogTable(sk, tableName, {
        name: tableName,
        columns: (columns || []).map((c) => ({
          name: c.name,
          type: c.type || c.dataType,
          comment: c.comment,
          pk: !!(c.pk || c.primaryKey)
        }))
      })
    }
  })

  const origRender = SqlEditor.prototype._renderCompletion
  SqlEditor.prototype._renderCompletion = function (...args) {
    const ret = origRender.apply(this, args)
    try {
      const st = this.completionState
      const rs = currentResultState()
      if (st?.open && st.items?.[st.index] && rs) {
        rs.lastCompletion = st.items[st.index]
        if (state.ui.rightOpen && rightMode === 'docs') renderRightPanel()
      }
    } catch {
      /* ignore */
    }
    return ret
  }

  bindResizers()
  bindGlobalKeys()
  bindChrome()

  await loadAll()
  await loadDialects()
  try {
    const v = await api?.settings?.get?.('followShellTheme')
    if (v !== undefined && v !== null) setFollowShellTheme(v !== false)
  } catch {
    /* ignore */
  }

  applySidebarCollapsed(!!state.ui.sidebarCollapsed)
  dom.rightPanel.style.width = `${state.ui.rightWidth || 280}px`
  dom.results.style.height = `${state.ui.bottomHeight || 300}px`
  if (!state.ui.sidebarCollapsed) {
    dom.side.style.width = `${state.ui.leftWidth || 240}px`
  }

  renderAll()
  side.setTab(state.ui.leftTab || 'sessions')

  api?.onEnter?.(() => {
    side?.render()
    renderAll()
  })
  api?.onBeforeClose?.(async () => {
    try {
      await flushPendingPersist()
    } catch {
      /* ignore */
    }
  })
  window.addEventListener('pagehide', () => {
    try {
      void flushPendingPersist()
    } catch {
      /* ignore */
    }
  })

  if (!api) showLocalToast('功能未就绪', 'warn')
  else if (!api.db && !api.vault) {
    state.runtime.hostLagNotified = true
    showLocalToast('功能未就绪', 'warn')
  }
}

/* ───────────── sidebar collapse ───────────── */

function applySidebarCollapsed(collapsed) {
  state.ui.sidebarCollapsed = !!collapsed
  dom.app?.classList.toggle('sidebar-collapsed', !!collapsed)
  if (!collapsed) {
    dom.side.style.width = `${state.ui.leftWidth || 240}px`
  } else {
    dom.side.style.width = ''
  }
  side?.setCollapsed(!!collapsed)
  setUiPref('sidebarCollapsed', !!collapsed)
  const toggle = dom.sideToggle
  if (toggle) {
    toggle.title = collapsed ? '展开侧栏' : '收起侧栏'
    toggle.textContent = collapsed ? '☰' : '≡'
  }
}

function setSidebarCollapsed(v) {
  applySidebarCollapsed(v)
}

/* ───────────── render ───────────── */

function renderAll() {
  renderEditorTabs()
  renderToolbar()
  renderEditorValue()
  renderResultTabs()
  renderStatus()
  renderRightPanel()
  side?.render()
}

function renderEditorTabs() {
  const s = currentSession()
  const editors = s?.editors || []
  if (!editors.length) {
    dom.editorTabs.innerHTML = `<span class="muted sm">—</span>
      <button type="button" class="btn icon" data-e="new" title="新建查询">＋</button>`
    dom.editorTabs.querySelector('[data-e=new]')?.addEventListener('click', () => {
      const sess = currentSession()
      if (sess) createEditorTab(sess)
      else void newSession()
      renderAll()
    })
    return
  }
  dom.editorTabs.innerHTML =
    editors
      .map(
        (e) =>
          `<div class="tab ed-tab${e.id === s.activeEditorId ? ' active' : ''}" data-id="${e.id}">
            ${esc(e.title)}${e.dirty ? ' *' : ''}
            <button type="button" class="tab-x" data-close="${e.id}" title="关闭">×</button>
          </div>`
      )
      .join('') +
    `<button type="button" class="btn icon" data-e="new" title="新建查询">＋</button>`
  dom.editorTabs.querySelectorAll('.ed-tab').forEach((el) => {
    el.addEventListener('click', () => {
      const sess = currentSession()
      if (!sess) return
      const ed = sess.editors.find((x) => x.id === el.dataset.id)
      if (!ed) return
      sess.activeEditorId = ed.id
      renderEditorTabs()
      renderEditorValue()
      renderResultTabs()
      renderStatus()
    })
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      editorTabContext(el.dataset.id, e)
    })
  })
  dom.editorTabs.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const sess = currentSession()
      if (!sess) return
      closeEditorTab(sess, btn.dataset.close)
      renderAll()
    })
  })
  dom.editorTabs.querySelector('[data-e=new]')?.addEventListener('click', () => {
    const sess = currentSession()
    if (sess) createEditorTab(sess)
    else void newSession()
    renderAll()
  })
}

function renderEditorValue() {
  const ed = currentEditor()
  if (!editor) return
  const sql = ed?.sql || ''
  if (editor.getValue() !== sql) editor.setValue(sql, { cursor: ed?.cursor, silent: true })
  editor.setDialect(currentDialect())
}

/** 顶栏：连接状态 chip（名称 · 驱动），无工具栏墙 */
function renderToolbar() {
  const conn = currentConnection()
  const s = currentSession()
  const open = !!(conn && state.runtime.sessionKeys.has(conn.id))
  const busy = !!state.runtime.executing
  const dotCls = busy ? 'busy' : open ? 'on' : ''
  const title = [conn?.name, conn ? driverLabel(conn.driver) : '', s?.name]
    .filter(Boolean)
    .join(' · ')
  dom.toolbar.innerHTML = `
    <span class="ctx-chip" title="${esc(title || '未选择连接')}">
      <span class="dot ${dotCls}"></span>
      <strong>${conn ? esc(conn.name || '连接') : '未连接'}</strong>
      ${conn ? `<span class="driver-chip ${String(conn.driver || '').toLowerCase().replace(/[^a-z0-9]/g, '') ? 'd-' + String(conn.driver).toLowerCase().replace(/[^a-z0-9]/g, '') : ''}">${esc(driverLabel(conn.driver))}</span>` : ''}
      ${conn?.readOnly ? '<span class="badge xs warn">只读</span>' : ''}
    </span>
  `
  if (dom.fabRun) {
    dom.fabRun.disabled = busy
    const label = busy ? '执行中…' : '执行当前语句'
    setTip(dom.fabRun, label)
    dom.fabRun.innerHTML = busy ? '…' : '▶'
  }
}

/** FAB ⋯：执行相关 */
function openFabMenu(ev) {
  const busy = !!state.runtime.executing
  const items = menuItems([
    ['run-all', '全部执行'],
    ['run-sel', '执行选中'],
    ['explain', '执行计划'],
    busy ? ['cancel', '取消查询'] : null
  ])
  openCtxMenu(ev, items, (k) => {
    if (k === 'run-all') void execute({ mode: 'all' })
    else if (k === 'run-sel') void execute({ mode: 'selection' })
    else if (k === 'explain') void execute({ mode: 'current', explain: true })
    else if (k === 'cancel') void cancelQuery()
  })
}

/** 顶栏 ⋯：次要操作 */
function openChromeMenu(ev) {
  const conn = currentConnection()
  const open = !!(conn && state.runtime.sessionKeys.has(conn.id))
  const busy = !!state.runtime.executing
  const dirty = !!(grid && grid.pendingChanges().length)
  const items = menuItems([
    ['connect', open ? '断开连接' : '连接'],
    ['save', '保存会话'],
    ['explain', '执行计划'],
    'sep',
    ['format', '注释'],
    ['complete', '代码提示'],
    ['right', state.ui.rightOpen ? '收起侧栏' : '变更面板'],
    dirty && conn && !conn.readOnly ? ['commit', '提交变更'] : null,
    dirty ? ['revert', '放弃变更'] : null,
    'sep',
    ['import', '导入表格'],
    ['export', '导出结果'],
    !currentSession() ? ['new-session', '新建会话'] : null,
    busy ? ['cancel', '取消查询'] : null
  ])
  openCtxMenu(ev, items, (k) => {
    if (k === 'new-session') void newSession()
    else if (k === 'connect') void toggleConnect(false)
    else if (k === 'save') void saveSessionNow()
    else if (k === 'explain') void execute({ mode: 'current', explain: true })
    else if (k === 'format') editor?.toggleComment()
    else if (k === 'complete') editor?.triggerCompletion(true)
    else if (k === 'import') openImportWizard()
    else if (k === 'export') openExportMenu()
    else if (k === 'commit') void commitChanges()
    else if (k === 'revert') {
      grid.revertAll()
      syncDockFromGrid()
      renderRightPanel()
    } else if (k === 'right') {
      state.ui.rightOpen = !state.ui.rightOpen
      setUiPref('rightOpen', state.ui.rightOpen)
      renderRightPanel()
    } else if (k === 'cancel') void cancelQuery()
  })
}

function syncDockFromGrid() {
  const dirty = !!(grid && grid.pendingChanges().length)
  if (dirty && !state.ui.rightOpen) {
    state.ui.rightOpen = true
    setUiPref('rightOpen', true)
  }
}

function renderResultTabs() {
  const ed = currentEditor()
  const rs = ed ? getResultState(ed.id) : null
  let tabsEl = dom.results.querySelector('.result-tabs')
  if (!tabsEl) {
    tabsEl = document.createElement('div')
    tabsEl.className = 'result-tabs'
    const bar = dom.results.querySelector('.grid-bar')
    if (bar && bar.nextSibling) dom.results.insertBefore(tabsEl, bar.nextSibling)
    else dom.results.insertBefore(tabsEl, dom.results.firstChild)
  }
  const tabs = rs?.tabs || []
  if (!tabs.length) tabsEl.hidden = true
  else {
    tabsEl.hidden = false
    tabsEl.innerHTML = tabs
      .map(
        (t, i) =>
          `<button type="button" class="tab${i === rs.activeTab ? ' active' : ''}" data-rt="${i}">${esc(
            t.label || `结果 ${i + 1}`
          )}</button>`
      )
      .join('')
    tabsEl.querySelectorAll('[data-rt]').forEach((b) => {
      b.addEventListener('click', () => {
        rs.activeTab = Number(b.dataset.rt)
        loadResultIntoGrid()
        renderResultTabs()
      })
    })
  }
  loadResultIntoGrid()
}

function loadResultIntoGrid() {
  const ed = currentEditor()
  const rs = ed ? getResultState(ed.id) : null
  const tab = rs?.tabs?.[rs.activeTab]
  const conn = currentConnection()
  const driverUpdatable = !['influxdb'].includes(conn?.driver)
  if (!tab) {
    grid.setResult({
      result: null,
      tableRef: null,
      readOnly: !!conn?.readOnly,
      driverUpdatable
    })
    return
  }
  grid.setResult({
    result: tab.result,
    tableRef: tab.tableRef || rs.tableRefOverride,
    readOnly: !!conn?.readOnly || !!tab.result?.readOnly,
    driverUpdatable
  })
}

function renderStatus() {
  const conn = currentConnection()
  const s = currentSession()
  const ed = currentEditor()
  const rs = ed ? getResultState(ed.id) : null
  const tab = rs?.tabs?.[rs.activeTab]
  const parts = []
  parts.push(conn ? `${conn.name || conn.id} · ${driverLabel(conn.driver)}` : '无连接')
  if (s?.database || conn?.database) parts.push(s?.database || conn.database)
  if (tab?.result) {
    parts.push(`${tab.result.rows?.length ?? 0} 行`)
    if (tab.result.durationMs != null) parts.push(`${tab.result.durationMs} ms`)
    if (tab.result.truncated) parts.push('截断')
  }
  if (conn?.readOnly) parts.push('只读')
  if (state.runtime.executing) parts.push('执行中…')
  if (state.runtime.hostLagNotified) parts.push('功能未就绪')
  dom.statusbar.innerHTML = parts.map((p) => `<span class="st-item">${esc(p)}</span>`).join('')
}

function renderRightPanel() {
  const open = !!state.ui.rightOpen
  dom.rightPanel.hidden = !open
  if (!open) return
  const changes = grid?.pendingChanges?.() || []
  const ed = currentEditor()
  const rs = ed ? getResultState(ed.id) : null
  const lastItem = rs?.lastCompletion
  dom.rightPanel.innerHTML = `
    <div class="right-tabs">
      <button type="button" data-rp="changes" class="${rightMode === 'changes' ? 'active' : ''}">变更${
        changes.length ? ` (${changes.length})` : ''
      }</button>
      <button type="button" data-rp="docs" class="${rightMode === 'docs' ? 'active' : ''}">代码提示</button>
      <button type="button" data-rp="ddl" class="${rightMode === 'ddl' ? 'active' : ''}">DDL</button>
      <button type="button" class="btn icon" data-rp="close" title="关闭">×</button>
    </div>
    <div class="right-body" data-el="rbody"></div>
  `
  dom.rightPanel.querySelectorAll('[data-rp]').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.rp === 'close') {
        state.ui.rightOpen = false
        setUiPref('rightOpen', false)
        renderRightPanel()
        return
      }
      rightMode = b.dataset.rp
      renderRightPanel()
    })
  })
  const body = dom.rightPanel.querySelector('[data-el=rbody]')
  if (rightMode === 'changes') {
    if (!changes.length) {
      body.innerHTML = `<div class="empty">暂无待提交变更</div>`
      return
    }
    body.innerHTML = `
      <div class="changes-actions">
        <button type="button" class="btn primary sm" data-c="commit">提交</button>
        <button type="button" class="btn sm" data-c="revert">放弃</button>
        <button type="button" class="btn sm" data-c="sql">SQL</button>
      </div>
      <div class="changes-list">
        ${changes
          .map(
            (c) => `<div class="change-item ${esc(c.status)}" data-idx="${c.idx}">
          <div class="ci-head"><strong>${esc(statusLabel(c.status))}</strong> <span class="muted">#${c.idx + 1}</span></div>
          <div class="ci-body"><code>${esc(changeSummary(c))}</code></div>
          ${c.error ? `<div class="ci-err">${esc(c.error)}</div>` : ''}
        </div>`
          )
          .join('')}
      </div>`
    body.querySelector('[data-c=commit]')?.addEventListener('click', () => void commitChanges())
    body.querySelector('[data-c=revert]')?.addEventListener('click', () => {
      grid.revertAll()
      syncDockFromGrid()
      renderRightPanel()
    })
    body.querySelector('[data-c=sql]')?.addEventListener('click', () => showSqlPreview('preview'))
    body.querySelectorAll('.change-item').forEach((el) => {
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const idx = Number(el.dataset.idx)
        openCtxMenu(
          e,
          [
            ['commit', '提交全部'],
            ['revert', '放弃全部'],
            'sep',
            ['discard', '放弃该项', { danger: true }],
            ['script', '生成到编辑器']
          ],
          (k) => {
            if (k === 'commit') void commitChanges()
            else if (k === 'revert') {
              grid.revertAll()
              syncDockFromGrid()
              renderRightPanel()
            } else if (k === 'discard') {
              grid.discardChange(idx)
              syncDockFromGrid()
              renderRightPanel()
            } else if (k === 'script') showSqlPreview('editor')
          }
        )
      })
    })
  } else if (rightMode === 'docs') {
    if (lastItem) {
      const meta = kindMeta(lastItem.kind)
      body.innerHTML = `<div class="doc-panel">
        <div class="doc-kind" style="color:${meta.color}">${esc(meta.label)}${
          lastItem.owner ? ' · ' + esc(lastItem.owner) : ''
        }</div>
        <div class="doc-label">${esc(lastItem.label)}</div>
        ${lastItem.detail ? `<div class="doc-detail">${esc(lastItem.detail)}</div>` : ''}
        ${lastItem.doc ? `<div class="doc-body">${esc(lastItem.doc)}</div>` : ''}
      </div>`
    } else {
      body.innerHTML = `<div class="empty">—</div>`
    }
  } else {
    body.innerHTML = `<div class="empty"><pre class="ddl">${esc(rs?.ddl || '—')}</pre></div>`
  }
}

function statusLabel(st) {
  return (
    { dirty: '已修改', inserted: '新增', deleted: '删除', failed: '失败', clean: '干净' }[st] || st
  )
}

function changeSummary(c) {
  if (c.status === 'inserted') {
    return `INSERT → ${JSON.stringify(zipCols(c.current)).slice(0, 140)}`
  }
  if (c.status === 'deleted') return `DELETE WHERE ${JSON.stringify(c.key)}`
  const cols = grid?.columns || []
  const diff = []
  cols.forEach((col, i) => {
    if (c.original?.[i] !== c.current?.[i]) {
      const a = c.original?.[i]
      const b = c.current?.[i]
      diff.push(`${col.name}: ${a == null ? 'NULL' : String(a)} → ${b == null ? 'NULL' : String(b)}`)
    }
  })
  return `UPDATE ${diff.join(', ') || '(无差异)'} WHERE ${JSON.stringify(c.key)}`
}

function zipCols(values) {
  const o = {}
  ;(grid?.columns || []).forEach((col, i) => {
    o[col.name] = values?.[i]
  })
  return o
}

/* ───────────── actions ───────────── */

async function loadDialects() {
  try {
    const list = await DbHost.dialectsList()
    state.runtime.dialects = Array.isArray(list) ? list : list?.dialects || []
  } catch {
    state.runtime.dialects = [
      { id: 'mysql', label: 'MySQL' },
      { id: 'sqlite', label: 'SQLite' },
      { id: 'postgres', label: 'PostgreSQL' },
      { id: 'timescale', label: 'TimescaleDB' },
      { id: 'influxdb', label: 'InfluxDB' },
      { id: 'tdengine', label: 'TDengine' }
    ]
  }
}

function selectSession(id) {
  setActiveSession(id)
  const s = currentSession()
  if (s) state.selectedConnectionId = s.connectionId
  renderAll()
}

async function newSession(connectionId) {
  if (!state.connections.length) {
    await openConnectionForm()
    return
  }
  const connId = connectionId || state.selectedConnectionId || state.connections[0].id
  const s = createSession({ connectionId: connId })
  if (!s) return
  state.selectedConnectionId = connId
  renderAll()
  return s
}

async function onSideAction(tab) {
  if (tab === 'connections') await openConnectionForm()
  else if (tab === 'sessions') await newSession()
  else if (tab === 'tree') {
    const conn = currentConnection()
    if (conn) await side.refreshTree(conn)
  } else if (tab === 'history') {
    state.queryHistory = []
    await persistNow(StorageKeys.queryHistory, [])
    side.render()
  }
}

async function onSessionAction(id, act) {
  if (act === 'open') {
    selectSession(id)
    return
  }
  if (act === 'rename') {
    const s = state.sessions.find((x) => x.id === id)
    const name = window.prompt('会话名称', s?.name || '')
    if (name) {
      renameSession(id, name)
      renderAll()
    }
  } else if (act === 'pin') {
    togglePinSession(id)
    side.render()
  } else if (act === 'dup') {
    duplicateSession(id)
    renderAll()
  } else if (act === 'export') {
    const s = state.sessions.find((x) => x.id === id)
    if (s) await exportSessions([s])
  } else if (act === 'del') {
    if (window.confirm('删除该控制台会话？')) {
      deleteSession(id)
      renderAll()
    }
  }
}

async function onConnectionAction(id, act) {
  state.selectedConnectionId = id
  if (act === 'connect' || act === 'open') {
    let s = state.sessions.find((x) => x.connectionId === id)
    if (!s) s = createSession({ connectionId: id })
    else setActiveSession(s.id)
    renderAll()
    await toggleConnect(true)
  } else if (act === 'edit') {
    await openConnectionForm(getConnection(id))
  } else if (act === 'dup' || act === 'copy') {
    duplicateConnection(id)
    side.render()
    showLocalToast('已复制连接配置', 'success')
  } else if (act === 'test') {
    await testConnectionById(id)
  } else if (act === 'readonly') {
    const c = getConnection(id)
    if (!c) return
    upsertConnection({ ...c, readOnly: !c.readOnly })
    side.render()
    renderToolbar()
    showLocalToast(c.readOnly ? '已取消只读' : '已设为只读', 'success')
  } else if (act === 'export') {
    const c = getConnection(id)
    if (c) await exportConnections([c])
  } else if (act === 'del') {
    if (window.confirm('删除连接配置？')) {
      const conn = getConnection(id)
      removeConnection(id)
      if (conn?.secretRef) {
        try {
          await Vault.remove(conn.secretRef)
        } catch {
          /* host lag */
        }
      }
      renderAll()
    }
  }
}

async function testConnectionById(id) {
  const conn = getConnection(id)
  if (!conn) return
  try {
    const res = await DbHost.test(toConnectionInput(conn))
    showLocalToast(
      res?.ok ? `连接成功 · ${res.message || ''} ${res.version || ''}` : `连接失败：${res?.message || '未知'}`,
      res?.ok ? 'success' : 'error'
    )
  } catch (e) {
    showLocalToast(hostLag(e) ? '功能未就绪' : String(e.message || e), 'warn')
  }
}

function connectionContext(id, ev) {
  state.selectedConnectionId = id
  const conn = getConnection(id)
  openCtxMenu(
    ev,
    [
      ['open', '连接'],
      ['edit', '编辑'],
      ['copy', '复制'],
      ['readonly', conn?.readOnly ? '取消只读' : '设为只读'],
      ['del', '删除', { danger: true }],
      'sep',
      ['test', '测试连接'],
      ['export', '导出配置']
    ],
    (k) => void onConnectionAction(id, k)
  )
}

function editorTabContext(editorId, ev) {
  const sess = currentSession()
  if (!sess) return
  openCtxMenu(
    ev,
    [
      ['close-others', '关闭其它'],
      ['rename', '重命名'],
      ['dup', '复制 Tab'],
      'sep',
      ['close', '关闭', { danger: true }]
    ],
    (k) => {
      if (k === 'close-others') {
        ;(sess.editors || []).slice().forEach((e) => {
          if (e.id !== editorId) closeEditorTab(sess, e.id)
        })
        if (!sess.editors.some((e) => e.id === editorId) && sess.editors[0]) {
          sess.activeEditorId = sess.editors[0].id
        } else {
          sess.activeEditorId = editorId
        }
        renderAll()
      } else if (k === 'rename') {
        const ed = sess.editors.find((x) => x.id === editorId)
        const name = window.prompt('Tab 名称', ed?.title || '')
        if (name && ed) {
          ed.title = name.trim() || ed.title
          ed.dirty = true
          renderEditorTabs()
        }
      } else if (k === 'dup') {
        const ed = sess.editors.find((x) => x.id === editorId)
        if (ed) createEditorTab(sess, `${ed.title.replace(/\.sql$/i, '')}-副本.sql`, ed.sql)
        renderAll()
      } else if (k === 'close') {
        closeEditorTab(sess, editorId)
        renderAll()
      }
    }
  )
}

function insertHistory(id) {
  const h = state.queryHistory.find((x) => x.id === id)
  const ed = currentEditor()
  if (!h || !ed) return
  if (!editor) return
  const sql = editor.getValue()
  const cursor = editor.el.ta.selectionStart
  editor.setValue(sql.slice(0, cursor) + h.sql + sql.slice(cursor), { silent: false })
  showLocalToast('已插入历史 SQL')
}

async function saveSessionNow() {
  const s = currentSession()
  const ed = currentEditor()
  if (ed) {
    ed.dirty = false
    ed.sql = editor.getValue()
    ed.cursor = editor.getCursor()
  }
  if (s) s.updatedAt = Date.now()
  await saveSessionsImmediate()
  renderEditorTabs()
  try {
    await api?.ui?.toast?.({ message: '控制台会话已保存', type: 'success' })
  } catch {
    showLocalToast('会话已保存', 'success')
  }
}

async function toggleConnect(forceOpen) {
  const conn = currentConnection()
  const s = currentSession()
  if (!conn) {
    await openConnectionForm()
    return
  }
  const existing = state.runtime.sessionKeys.get(conn.id)
  if (existing && !forceOpen) {
    try {
      await DbHost.close(existing)
    } catch (e) {
      if (!hostLag(e)) showLocalToast(String(e.message || e).slice(0, 120), 'warn')
    }
    state.runtime.sessionKeys.delete(conn.id)
    invalidateCatalog(existing)
    renderToolbar()
    renderStatus()
    showLocalToast('已断开连接')
    return
  }
  if (existing && forceOpen) return
  try {
    const database = s?.database || conn.database
    const preferredKey = sessionKeyOf(conn.id, database)
    const res = await DbHost.open({
      config: toConnectionInput(conn, { database }),
      sessionKey: preferredKey
    })
    const sessionKey = res?.sessionKey || res?.key || preferredKey
    state.runtime.sessionKeys.set(conn.id, sessionKey)
    conn.lastConnectedAt = Date.now()
    if (res?.dialect) conn.dialect = res.dialect
    upsertConnection(conn)
    if (res?.catalog) setCatalog(sessionKey, res.catalog)
    // 预热本地 catalog（宿主 completion 会话未就绪时仍可提示表/列）
    void warmCatalogFromHost(sessionKey, {
      driver: conn.driver,
      database,
      schema: s?.schema || conn.schema,
      tablesFn: (q) => DbHost.schema.tables(q),
      describeFn: (q) => DbHost.schema.describe(q)
    })
    showLocalToast('连接已打开', 'success')
    try {
      await notify({ title: '数据库', body: `已连接 ${conn.name}` })
    } catch {
      /* ignore */
    }
  } catch (e) {
    const msg = hostLag(e) ? '功能未就绪' : String(e.message || e).slice(0, 160)
    showLocalToast(msg, hostLag(e) ? 'warn' : 'error')
  }
  renderToolbar()
  renderStatus()
}

async function execute({ mode = 'current', explain = false } = {}) {
  const conn = currentConnection()
  const ed = currentEditor()
  const s = currentSession()
  if (!conn || !ed) {
    toast('请先选择连接与编辑器', 'warn')
    return
  }
  ed.sql = editor.getValue()
  const stmt = editor.getSelectionOrStatement(mode)
  const sql = (stmt.sql || '').trim()
  if (!sql) {
    showLocalToast('没有可执行的 SQL', 'warn')
    return
  }

  const danger = detectDangerousSql(sql)
  if (danger && danger.level === 'danger') {
    if (!window.confirm(`检测到${danger.reason}，确定执行？\n\n${sql.slice(0, 400)}`)) return
  }
  const isWrite = /\b(insert|update|delete|drop|alter|truncate|create|replace|merge|upsert)\b/i.test(sql)
  const needConfirm =
    isWrite && (conn.env === 'prod' || conn.env === 'production' || conn.options?.requireConfirm === true)
  if (needConfirm) {
    if (!window.confirm(`生产环境写操作，确认执行？\n\n${sql.slice(0, 400)}`)) return
  }

  if (!state.runtime.sessionKeys.has(conn.id)) {
    await toggleConnect(true)
    if (!state.runtime.sessionKeys.has(conn.id)) {
      showLocalToast('未连接，无法执行', 'warn')
      return
    }
  }
  const sessionKey = currentSessionKey()
  state.runtime.executing = true
  renderToolbar()
  renderStatus()
  const rs = currentResultState()
  const started = Date.now()
  try {
    const req = {
      sessionKey,
      sql,
      maxRows: 1000,
      confirmed: needConfirm || isWrite,
      database: s?.database || conn.database,
      schema: s?.schema || conn.schema
    }
    const raw = explain ? await DbHost.explain(req) : await DbHost.execute(req)
    const list = Array.isArray(raw) ? raw : [raw]
    rs.tabs = list.map((r, i) => ({
      label: explain ? `执行计划 ${i + 1}` : `结果 ${i + 1}`,
      result: r,
      tableRef: r?.tableRef || detectTableRef(sql, s, conn)
    }))
    rs.activeTab = 0
    rs.error = ''
    ed.lastRun = {
      sql,
      durationMs: list[0]?.durationMs ?? Date.now() - started,
      rowCount: list[0]?.rowCount ?? list[0]?.rows?.length ?? 0,
      ts: Date.now(),
      truncated: list[0]?.truncated
    }
    if (detectDdl(sql)) {
      invalidateCatalog(sessionKey)
      void warmCatalogFromHost(sessionKey, {
        driver: conn.driver,
        database: s?.database || conn.database,
        schema: s?.schema || conn.schema,
        tablesFn: (q) => DbHost.schema.tables(q),
        describeFn: (q) => DbHost.schema.describe(q)
      })
    }
    pushHistory({
      connectionId: conn.id,
      sql,
      durationMs: ed.lastRun.durationMs,
      rowCount: ed.lastRun.rowCount,
      sessionName: s?.name
    })
    showLocalToast(`完成 · ${ed.lastRun.rowCount} 行 · ${ed.lastRun.durationMs} ms`, 'success')
  } catch (e) {
    const msg = String(e.message || e)
    rs.tabs = [
      {
        label: '错误',
        result: {
          columns: [{ name: 'error' }],
          rows: [[msg]],
          rowCount: 0,
          durationMs: Date.now() - started
        }
      }
    ]
    rs.error = msg
    pushHistory({
      connectionId: conn.id,
      sql,
      durationMs: Date.now() - started,
      rowCount: 0,
      error: msg,
      sessionName: s?.name
    })
    showLocalToast(hostLag(e) ? '功能未就绪' : msg.slice(0, 160), hostLag(e) ? 'warn' : 'error')
  } finally {
    state.runtime.executing = false
    renderToolbar()
    renderResultTabs()
    renderStatus()
    syncDockFromGrid()
    renderRightPanel()
  }
}

function detectTableRef(sql, session, conn) {
  const bare = String(sql || '').replace(/--[^\n]*/g, '')
  const m = bare.match(/\bfrom\s+(`?[\w$]+`?(?:\s*\.\s*`?[\w$]+`?)?)/i)
  if (!m) return null
  const parts = m[1].replace(/`/g, '').split('.')
  if (parts.length === 3) return { database: parts[0], schema: parts[1], table: parts[2] }
  if (parts.length === 2) return { schema: parts[0], table: parts[1] }
  return {
    database: session?.database || conn?.database,
    schema: session?.schema,
    table: parts[0]
  }
}

async function cancelQuery() {
  try {
    await DbHost.cancel({ sessionKey: currentSessionKey() })
    showLocalToast('已请求取消', 'info')
  } catch (e) {
    showLocalToast(hostLag(e) ? '功能未就绪' : String(e.message || e), 'warn')
  }
}

async function commitChanges() {
  const conn = currentConnection()
  const changes = grid.toRowChanges()
  if (!changes.length) {
    toast('无待提交变更', 'info')
    return
  }
  if (conn?.readOnly) {
    toast('连接只读，无法提交', 'error')
    return
  }
  const preview = grid.sqlPreview(changes)
  if (!window.confirm(`将提交 ${changes.length} 条变更：\n\n${preview.slice(0, 800)}`)) return
  try {
    const res = await DbHost.applyChanges({
      sessionKey: currentSessionKey(),
      changes,
      mode: 'stop-on-error',
      // UI 已二次确认；prod/requireConfirm 宿主也要求 confirmed
      confirmed: true
    })
    const out = grid.applyBatchResult(res, changes)
    const affected = res?.results?.filter((r) => r.ok).length ?? 0
    toast(
      `提交完成：${affected} 成功${out.anyFail ? '，部分失败' : ''}`,
      out.anyFail ? 'warn' : 'success'
    )
  } catch (e) {
    toast(
      hostLag(e) ? '功能未就绪' : String(e.message || e).slice(0, 160),
      hostLag(e) ? 'warn' : 'error'
    )
  }
  syncDockFromGrid()
  renderRightPanel()
  renderStatus()
}

function showSqlPreview(kind) {
  const preview = grid.sqlPreview()
  if (kind === 'editor') {
    const s = currentSession()
    if (createEditorTab(s, `changes-${Date.now().toString(36)}.sql`, preview)) {
      renderAll()
      return
    }
  }
  window.prompt('SQL 预览（Ctrl+C 复制）', preview)
}

function openExportMenu() {
  const { cols, rows } = grid.getExportData('all')
  const formats = [
    ['csv', 'CSV 文件'],
    ['json', 'JSON 文件'],
    ['sql', 'SQL INSERT 文件'],
    ['md', 'Markdown 文件'],
    ['tsv', '复制 TSV（Excel）'],
    ['json-copy', '复制 JSON'],
    ['sql-copy', '复制 SQL'],
    ['md-copy', '复制 Markdown']
  ]
  dom.modalRoot.innerHTML = `
    <div class="modal-mask">
      <div class="modal small">
        <div class="modal-head"><strong>导出结果</strong><button type="button" class="btn ghost" data-act="close">关闭</button></div>
        <div class="modal-body export-menu">
          ${formats
            .map(([k, label]) => `<button type="button" class="btn block" data-f="${k}">${label}</button>`)
            .join('')}
        </div>
      </div>
    </div>`
  const close = () => (dom.modalRoot.innerHTML = '')
  dom.modalRoot.querySelector('[data-act=close]')?.addEventListener('click', close)
  dom.modalRoot.querySelectorAll('[data-f]').forEach((b) => {
    b.addEventListener('click', async () => {
      const f = b.dataset.f
      close()
      if (f.endsWith('-copy')) await copyResult(f.replace('-copy', ''), cols, rows)
      else await exportResult(f, cols, rows, grid.tableRef, state.ui)
    })
  })
}

function openImportWizard() {
  const tableRef = grid?.tableRef || currentResultState()?.tableRefOverride || null
  const defaultTable = tableRef
    ? [tableRef.schema, tableRef.table].filter(Boolean).join('.')
    : ''
  createImportWizard(dom.modalRoot, {
    sessionKey: currentSessionKey(),
    hostReady: !!api?.db,
    tableRef,
    defaultTable
  })
}

async function openTableData(node, conn) {
  const table = node.name || node.label
  const tableRef = {
    database: node.database || conn?.database,
    schema: node.schema,
    table
  }
  const quoted = quoteIdent(
    [tableRef.database, tableRef.schema, tableRef.table].filter(Boolean).join('.')
  )
  const sql = `SELECT * FROM ${quoted} LIMIT 200`
  let s = currentSession()
  if (!s || s.connectionId !== conn.id) {
    s = createSession({ connectionId: conn.id, name: `${table} 数据` })
    state.selectedConnectionId = conn.id
  }
  const ed = currentEditor()
  if (ed) {
    ed.sql = sql
    ed.title = `${table}.sql`
  }
  const rs = currentResultState()
  if (rs) rs.tableRefOverride = tableRef
  renderAll()
  await execute({ mode: 'current' })
  const rs2 = currentResultState()
  if (rs2) {
    rs2.tableRefOverride = tableRef
    if (rs2.tabs?.[rs2.activeTab]) rs2.tabs[rs2.activeTab].tableRef = tableRef
    loadResultIntoGrid()
  }
}

async function treeContext(node, conn, ev) {
  const table = node.name || node.label
  const isTable =
    node.type === 'table' || node.type === 'view' || node.type === 'measurement'
  const items = isTable
    ? [
        ['data', '打开数据'],
        ['select', 'SELECT *'],
        ['count', 'SELECT COUNT'],
        ['copy', '复制名称'],
        ['ddl', '查看 DDL'],
        'sep',
        ['refresh', '刷新']
      ]
    : [
        ['refresh', '刷新'],
        ['copy', '复制名称']
      ]
  openCtxMenu(ev, items, async (k) => {
    const qname = quoteIdent(
      [node.database || conn.database, node.schema, table].filter(Boolean).join('.')
    )
    if (k === 'data') await openTableData(node, conn)
    else if (k === 'select' || k === 'count') {
      const sql =
        k === 'select' ? `SELECT * FROM ${qname} LIMIT 200` : `SELECT COUNT(*) AS cnt FROM ${qname}`
      const ed = currentEditor()
      if (ed) {
        ed.sql = sql
        editor.setValue(sql, { silent: true })
      }
      renderEditorTabs()
    } else if (k === 'copy') {
      await clipboardWrite(table)
      showLocalToast('已复制名称', 'success')
    } else if (k === 'ddl') {
      try {
        const sessionKey =
          state.runtime.sessionKeys.get(conn.id) || sessionKeyOf(conn.id, conn.database)
        const res = await DbHost.schema.ddl({
          sessionKey,
          database: node.database || conn.database,
          schema: node.schema,
          table
        })
        const ddl = typeof res === 'string' ? res : res?.ddl || JSON.stringify(res, null, 2)
        const rs = currentResultState()
        if (rs) rs.ddl = ddl
        state.ui.rightOpen = true
        setUiPref('rightOpen', true)
        rightMode = 'ddl'
        renderRightPanel()
      } catch (e) {
        showLocalToast(hostLag(e) ? '功能未就绪' : String(e.message || e).slice(0, 120), 'warn')
      }
    } else if (k === 'refresh') await side.refreshTree(conn)
  })
}

/* ───────────── connection form ───────────── */

function optionsToKv(options) {
  const obj = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
  return Object.entries(obj).map(([k, v]) => ({
    key: String(k),
    value: typeof v === 'string' ? v : JSON.stringify(v)
  }))
}

function kvToOptions(rows) {
  const out = {}
  for (const r of rows || []) {
    const k = String(r.key || '').trim()
    if (!k) continue
    const raw = String(r.value ?? '')
    let val = raw
    if (raw === 'true') val = true
    else if (raw === 'false') val = false
    else if (raw !== '' && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) val = Number(raw)
    out[k] = val
  }
  return out
}

function defaultPortFor(driver) {
  const map = { mysql: 3306, timescale: 5432, postgres: 5432, influxdb: 8086, tdengine: 6030, sqlite: null }
  return map[driver] ?? undefined
}

async function openConnectionForm(existing) {
  const isEdit = !!existing
  const dialects = state.runtime.dialects.length
    ? state.runtime.dialects
    : [
        { id: 'mysql', label: 'MySQL' },
        { id: 'sqlite', label: 'SQLite' },
        { id: 'postgres', label: 'PostgreSQL' },
        { id: 'timescale', label: 'TimescaleDB' },
        { id: 'influxdb', label: 'InfluxDB' },
        { id: 'tdengine', label: 'TDengine' }
      ]
  const c = existing || {
    id: uid('conn'),
    name: '',
    driver: 'mysql',
    host: 'localhost',
    port: 3306,
    database: '',
    username: '',
    env: 'dev',
    color: '#1a1f2e',
    note: '',
    readOnly: false,
    favorite: false,
    options: {},
    sqlitePath: '',
    secretRef: ''
  }
  const hasSecret = !!c.secretRef
  let kvRows = optionsToKv(c.options)
  // 时序库常用字段若已在 options 里，保留在键值行
  const envLabel = { dev: '开发', staging: '预发', prod: '生产', test: '测试' }

  const renderKv = () =>
    kvRows
      .map(
        (r, i) => `
      <div class="kv-row" data-i="${i}">
        <input data-kvk="key" placeholder="键" value="${esc(r.key)}" />
        <input data-kvk="value" placeholder="值" value="${esc(r.value)}" />
        <button type="button" class="btn icon" data-act="kv-del" data-i="${i}" title="删除该项" aria-label="删除该项">×</button>
      </div>`
      )
      .join('')

  dom.modalRoot.innerHTML = `
    <div class="modal-mask">
      <div class="modal wide">
        <div class="modal-head">
          <strong>${isEdit ? '编辑连接' : '新建连接'}</strong>
          <button type="button" class="btn ghost" data-act="close" title="关闭" aria-label="关闭">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <label class="span2">名称
              <input data-k="name" value="${esc(c.name || '')}" placeholder="例如：订单库-生产" />
            </label>
            <label>驱动
              <select data-k="driver">
                ${dialects
                  .map(
                    (d) =>
                      `<option value="${esc(d.id)}" ${c.driver === d.id ? 'selected' : ''}>${esc(d.label || d.id)}</option>`
                  )
                  .join('')}
              </select>
            </label>
            <label>环境
              <select data-k="env">
                ${['dev', 'staging', 'prod', 'test']
                  .map(
                    (e) =>
                      `<option value="${e}" ${c.env === e ? 'selected' : ''}>${envLabel[e] || e}</option>`
                  )
                  .join('')}
              </select>
            </label>
            <label data-f="net">主机
              <input data-k="host" value="${esc(c.host || '')}" placeholder="127.0.0.1" />
            </label>
            <label data-f="net">端口
              <input data-k="port" type="number" value="${c.port ?? ''}" placeholder="3306" />
            </label>
            <label data-f="db">数据库
              <input data-k="database" value="${esc(c.database || '')}" placeholder="库名 / bucket" />
            </label>
            <label data-f="user">用户名
              <input data-k="username" value="${esc(c.username || '')}" />
            </label>
            <label class="span2" data-f="user">密码
              <input data-k="secret" type="password" placeholder="${hasSecret ? '已保存，可留空' : '仅保存在本机'}" />
            </label>
            <label class="span2" data-f="file">SQLite 文件
              <div class="row">
                <input data-k="sqlitePath" value="${esc(c.sqlitePath || '')}" placeholder="选择或填写 .db 路径" />
                <button type="button" class="btn" data-act="pick-sqlite" title="选择数据库文件">选择文件</button>
              </div>
            </label>
            <div class="form-check-row">
              <label><input data-k="readOnly" type="checkbox" ${c.readOnly ? 'checked' : ''}/> 只读</label>
              <label><input data-k="favorite" type="checkbox" ${c.favorite ? 'checked' : ''}/> 收藏</label>
              <label>颜色 <input data-k="color" type="color" value="${esc(c.color || '#1a1f2e')}" style="width:44px;min-height:28px" /></label>
            </div>
            <label class="span2">备注
              <input data-k="note" value="${esc(c.note || '')}" placeholder="用途说明（可选）" />
            </label>
            <div class="field-group-title">附加选项（键值，例如 schema / org / bucket / ssl）</div>
            <div class="span2 kv-list" data-el="kv">${renderKv()}</div>
            <div class="span2">
              <button type="button" class="btn ghost kv-add" data-act="kv-add" title="添加选项">＋ 添加选项</button>
            </div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn" data-act="test">测试连接</button>
            <button type="button" class="btn" data-act="clear-secret" ${hasSecret ? '' : 'disabled'} title="清除已保存密码">清除密码</button>
            <span class="spacer" style="flex:1"></span>
            <button type="button" class="btn" data-act="close">取消</button>
            <button type="button" class="btn primary" data-act="save">保存</button>
          </div>
          <div class="hint" data-el="form-hint"></div>
        </div>
      </div>
    </div>`

  const hint = dom.modalRoot.querySelector('[data-el=form-hint]')
  const kvBox = dom.modalRoot.querySelector('[data-el=kv]')

  const syncDriverFields = () => {
    const driver = dom.modalRoot.querySelector('[data-k=driver]').value
    const isSqlite = driver === 'sqlite'
    const isFile = isSqlite
    dom.modalRoot.querySelectorAll('[data-f=net]').forEach((el) => {
      el.style.display = isSqlite ? 'none' : ''
    })
    dom.modalRoot.querySelectorAll('[data-f=file]').forEach((el) => {
      el.style.display = isFile ? '' : 'none'
    })
    // SQLite 通常无用户密码；时序库仍有 token/用户
    const showUser = !isSqlite || true
    dom.modalRoot.querySelectorAll('[data-f=user]').forEach((el) => {
      el.style.display = showUser ? '' : 'none'
    })
    const portEl = dom.modalRoot.querySelector('[data-k=port]')
    if (!isEdit && portEl && !portEl.dataset.touched) {
      const p = defaultPortFor(driver)
      portEl.value = p == null ? '' : p
      if (driver === 'influxdb') {
        const host = dom.modalRoot.querySelector('[data-k=host]')
        if (host && !host.value) host.placeholder = '127.0.0.1'
      }
    }
  }

  const bindKv = () => {
    kvBox.querySelectorAll('.kv-row').forEach((row) => {
      const i = Number(row.dataset.i)
      row.querySelectorAll('[data-kvk]').forEach((inp) => {
        inp.addEventListener('input', () => {
          kvRows[i] = kvRows[i] || { key: '', value: '' }
          kvRows[i][inp.dataset.kvk] = inp.value
        })
      })
      row.querySelector('[data-act=kv-del]')?.addEventListener('click', () => {
        kvRows.splice(Number(row.dataset.i), 1)
        kvBox.innerHTML = renderKv()
        bindKv()
      })
    })
  }

  const readForm = () => {
    const get = (k) => dom.modalRoot.querySelector(`[data-k=${k}]`)
    const driver = get('driver').value
    const options = kvToOptions(kvRows)
    return {
      id: c.id,
      name: get('name').value.trim() || '未命名连接',
      driver,
      dialect: driver,
      host: driver === 'sqlite' ? '' : get('host').value.trim(),
      port: driver === 'sqlite' ? undefined : get('port').value ? Number(get('port').value) : undefined,
      database: get('database').value.trim(),
      username: get('username').value.trim(),
      env: get('env').value,
      color: get('color').value,
      note: get('note').value,
      sqlitePath: get('sqlitePath').value.trim(),
      readOnly: get('readOnly').checked,
      favorite: get('favorite').checked,
      options,
      secretRef: c.secretRef,
      createdAt: c.createdAt
    }
  }

  const close = () => (dom.modalRoot.innerHTML = '')
  dom.modalRoot.querySelectorAll('[data-act=close]').forEach((b) => b.addEventListener('click', close))
  bindKv()
  syncDriverFields()
  dom.modalRoot.querySelector('[data-k=driver]')?.addEventListener('change', syncDriverFields)
  dom.modalRoot.querySelector('[data-k=port]')?.addEventListener('input', (e) => {
    e.target.dataset.touched = '1'
  })
  dom.modalRoot.querySelector('[data-act=kv-add]')?.addEventListener('click', () => {
    kvRows.push({ key: '', value: '' })
    kvBox.innerHTML = renderKv()
    bindKv()
  })

  dom.modalRoot.querySelector('[data-act=pick-sqlite]')?.addEventListener('click', async () => {
    try {
      const picked = await DbHost.pickSqliteFile()
      const path =
        picked?.path || picked?.filePath || (typeof picked === 'string' ? picked : '')
      if (path) {
        dom.modalRoot.querySelector('[data-k=sqlitePath]').value = path
        hint.textContent = path
      }
    } catch (e) {
      hint.textContent = hostLag(e) ? '功能未就绪' : String(e.message || e)
    }
  })

  dom.modalRoot.querySelector('[data-act=test]')?.addEventListener('click', async () => {
    const form = readForm()
    const secret = dom.modalRoot.querySelector('[data-k=secret]').value
    let secretRef = form.secretRef
    if (secret) {
      try {
        const r = await Vault.set(`conn:${form.id}:auth`, secret)
        secretRef = r?.secretRef || r
        form.secretRef = secretRef
        hint.textContent = '密码已保存，正在测试…'
      } catch (e) {
        hint.textContent = `密码保存失败：${e.message || e}`
      }
    }
    try {
      const res = await DbHost.test(toConnectionInput({ ...form, secretRef }))
      hint.textContent = res?.ok
        ? `连接成功 · ${res.message || ''} ${res.version || ''}`
        : `连接失败：${res?.message || '未知'}`
    } catch (e) {
      hint.textContent = hostLag(e) ? '功能未就绪' : String(e.message || e)
    }
  })

  dom.modalRoot.querySelector('[data-act=clear-secret]')?.addEventListener('click', async () => {
    if (!c.secretRef) return
    try {
      await Vault.remove(c.secretRef)
    } catch {
      /* ignore */
    }
    c.secretRef = ''
    hint.textContent = '已清除已保存密码'
  })

  dom.modalRoot.querySelector('[data-act=save]')?.addEventListener('click', async () => {
    const form = readForm()
    if (!form.name) {
      hint.textContent = '请填写名称'
      return
    }
    if (form.driver !== 'sqlite' && !form.host) {
      hint.textContent = '请填写主机地址'
      return
    }
    if (form.driver === 'sqlite' && !form.sqlitePath) {
      hint.textContent = '请选择 SQLite 文件'
      return
    }
    if (form.env === 'prod') {
      const dup = state.connections.find(
        (x) => x.id !== form.id && x.name === form.name && x.env === 'prod'
      )
      if (dup) hint.textContent = '生产环境存在同名连接'
    }
    const secret = dom.modalRoot.querySelector('[data-k=secret]').value
    if (secret) {
      try {
        const r = await Vault.set(`conn:${form.id}:auth`, secret)
        form.secretRef = r?.secretRef || r
      } catch (e) {
        showLocalToast(
          hostLag(e) ? '功能未就绪，密码未保存' : String(e.message || e),
          'warn'
        )
      }
    }
    upsertConnection(form)
    state.selectedConnectionId = form.id
    close()
    renderAll()
    toast('连接已保存', 'success')
  })
}

/* ───────────── chrome ───────────── */

function bindChrome() {
  dom.sideToggle?.addEventListener('click', () => {
    setSidebarCollapsed(!state.ui.sidebarCollapsed)
  })
  dom.topMore?.addEventListener('click', (e) => openChromeMenu(e))
  dom.fabRun?.addEventListener('click', () => void execute({ mode: 'current' }))
  dom.fabMore?.addEventListener('click', (e) => openFabMenu(e))
}

function bindResizers() {
  makeResizer($('#resizer-left'), dom.side, 'width', (v) => setUiPref('leftWidth', v), false)
  makeResizer($('#resizer-bottom'), dom.results, 'height', (v) => setUiPref('bottomHeight', v), true)
  makeResizer($('#resizer-right'), dom.rightPanel, 'width', (v) => setUiPref('rightWidth', v), false)
}

function makeResizer(handle, target, prop, commit, invert) {
  if (!handle || !target) return
  handle.addEventListener('mousedown', (e) => {
    if (state.ui.sidebarCollapsed && target === dom.side) return
    e.preventDefault()
    const start = invert ? e.clientY : e.clientX
    const startSize = invert ? target.offsetHeight : target.offsetWidth
    const calc = (ev) => {
      const delta = invert ? start - ev.clientY : ev.clientX - start
      return Math.max(invert ? 120 : 180, startSize + delta)
    }
    const onMove = (ev) => {
      target.style[prop] = calc(ev) + 'px'
    }
    const onUp = (ev) => {
      commit(calc(ev))
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
}

function bindGlobalKeys() {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void saveSessionNow()
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault()
      openExportMenu()
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      void commitChanges()
    }
    if (mod && e.key.toLowerCase() === 't') {
      e.preventDefault()
      const s = currentSession()
      if (s) createEditorTab(s)
      else void newSession()
      renderAll()
    }
  })
}

function showLocalToast(message, type = 'info') {
  const el = dom.toastLocal
  el.textContent = String(message ?? '').slice(0, 200)
  el.dataset.type = type
  el.hidden = false
  el.classList.add('show')
  clearTimeout(showLocalToast._t)
  showLocalToast._t = setTimeout(() => {
    el.classList.remove('show')
    el.hidden = true
  }, 3200)
}

void saveTextFile
void closeCtxMenu
void dialectOf

void boot()
