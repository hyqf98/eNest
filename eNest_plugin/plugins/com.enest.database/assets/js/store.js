/**
 * store.js — 内存状态 + enest.storage 持久化（Spec 2.0 键空间）
 */
import { StorageKeys, storageGet, storageSet, toast } from './api.js'

const LIMITS = {
  sessions: 50,
  editorsPerSession: 20,
  sqlBytes: 1024 * 1024,
  history: 500
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export const state = {
  connections: [],
  sessions: [],
  activeSessionId: null,
  queryHistory: [],
  completionUsage: {},
  ui: {
    leftWidth: 240,
    rightWidth: 280,
    rightOpen: false,
    bottomHeight: 300,
    sidebarCollapsed: false,
    autoReconnect: false,
    learnUsage: true,
    exportBom: true,
    autoAliasAfterTable: false,
    leftTab: 'sessions' // sessions | connections | tree | history
  },
  // runtime
  runtime: {
    sessionKeys: new Map(), // connectionId -> sessionKey
    catalogs: new Map(), // sessionKey -> { catalog, ts }
    dialects: [],
    hostLagNotified: false,
    executing: false,
    lastExecuteToken: 0,
    activeQuery: null
  },
  /** editorId -> ResultState */
  results: new Map(),
  schemaNodes: new Map(), // connectionId -> expanded node cache
  selectedConnectionId: null
}

const persistTimers = new Map()

function schedulePersist(key, value, delay = 800) {
  clearTimeout(persistTimers.get(key))
  persistTimers.set(
    key,
    setTimeout(() => {
      storageSet(key, value).catch(() => {})
    }, delay)
  )
}

export function persistNow(key, value) {
  clearTimeout(persistTimers.get(key))
  return storageSet(key, value)
}

export function persistAll() {
  return Promise.all([
    persistNow(StorageKeys.connections, state.connections),
    persistNow(StorageKeys.sessions, state.sessions),
    persistNow(StorageKeys.activeSessionId, state.activeSessionId),
    persistNow(StorageKeys.queryHistory, state.queryHistory),
    persistNow(StorageKeys.completionUsage, state.completionUsage),
    persistNow(StorageKeys.ui, state.ui)
  ])
}

/** 清掉防抖定时器并立即落盘（beforeClose / pagehide） */
export function flushPendingPersist() {
  for (const timer of persistTimers.values()) clearTimeout(timer)
  persistTimers.clear()
  return persistAll()
}

export async function loadAll() {
  const [connections, sessions, activeId, history, usage, ui] = await Promise.all([
    storageGet(StorageKeys.connections, []),
    storageGet(StorageKeys.sessions, []),
    storageGet(StorageKeys.activeSessionId, null),
    storageGet(StorageKeys.queryHistory, []),
    storageGet(StorageKeys.completionUsage, {}),
    storageGet(StorageKeys.ui, {})
  ])
  try {
    state.connections = Array.isArray(connections) ? connections : []
    state.sessions = Array.isArray(sessions) ? sessions : []
    state.queryHistory = Array.isArray(history) ? history : []
    state.completionUsage = usage && typeof usage === 'object' ? usage : {}
    state.ui = { ...state.ui, ...(ui && typeof ui === 'object' ? ui : {}) }
    state.activeSessionId =
      activeId && state.sessions.some((s) => s.id === activeId) ? activeId : state.sessions[0]?.id || null
    // 恢复后修正过的 activeSessionId 立即回写，避免下次仍读到失效 id
    if (activeId !== state.activeSessionId) {
      await persistNow(StorageKeys.activeSessionId, state.activeSessionId)
    }
  } catch {
    state.connections = []
    state.sessions = []
    state.queryHistory = []
    state.completionUsage = {}
    state.activeSessionId = null
    await toast('会话数据损坏，已重置', 'warn')
  }
  return state
}

/* ── connections ── */

export function getConnection(id) {
  return state.connections.find((c) => c.id === id) || null
}

export function activeConnection() {
  const sess = activeSession()
  return sess ? getConnection(sess.connectionId) : getConnection(state.selectedConnectionId)
}

export function upsertConnection(conn) {
  const idx = state.connections.findIndex((c) => c.id === conn.id)
  const next = { ...conn, updatedAt: Date.now() }
  if (idx >= 0) state.connections[idx] = { ...state.connections[idx], ...next }
  else state.connections.unshift({ ...next, id: conn.id || uid('conn'), createdAt: Date.now() })
  schedulePersist(StorageKeys.connections, state.connections, 200)
  return idx >= 0 ? state.connections[idx] : state.connections[0]
}

export function removeConnection(id) {
  state.connections = state.connections.filter((c) => c.id !== id)
  state.runtime.sessionKeys.delete(id)
  state.sessions = state.sessions.filter((s) => s.connectionId !== id)
  if (state.activeSessionId && !state.sessions.some((s) => s.id === state.activeSessionId)) {
    state.activeSessionId = state.sessions[0]?.id || null
  }
  schedulePersist(StorageKeys.connections, state.connections, 100)
  schedulePersist(StorageKeys.sessions, state.sessions, 100)
  schedulePersist(StorageKeys.activeSessionId, state.activeSessionId, 100)
}

export function duplicateConnection(id) {
  const c = getConnection(id)
  if (!c) return null
  const copy = {
    ...c,
    id: uid('conn'),
    name: `${c.name || '连接'}-副本`,
    secretRef: undefined,
    favorite: false,
    lastConnectedAt: undefined,
    createdAt: Date.now()
  }
  delete copy.secretRef
  state.connections.unshift(copy)
  schedulePersist(StorageKeys.connections, state.connections, 100)
  return copy
}

/* ── console sessions (DB-D) ── */

export function activeSession() {
  return state.sessions.find((s) => s.id === state.activeSessionId) || null
}

export function activeEditor() {
  const s = activeSession()
  if (!s) return null
  return s.editors.find((e) => e.id === s.activeEditorId) || s.editors[0] || null
}

export function createEditorTab(session, title, sql = '') {
  const editor = {
    id: uid('ed'),
    title: title || `query-${(session.editors?.length || 0) + 1}.sql`,
    sql: sql.slice(0, LIMITS.sqlBytes),
    cursor: { line: 0, ch: 0 },
    dirty: false,
    gridState: { page: 0, pageSize: 200 }
  }
  session.editors = session.editors || []
  if (session.editors.length >= LIMITS.editorsPerSession) {
    toast(`单会话编辑器最多 ${LIMITS.editorsPerSession} 个`, 'warn')
    return null
  }
  session.editors.push(editor)
  session.activeEditorId = editor.id
  session.updatedAt = Date.now()
  schedulePersistSessions()
  return editor
}

export function createSession({ connectionId, database, schema, name } = {}) {
  if (state.sessions.length >= LIMITS.sessions) {
    // 淘汰最旧未置顶
    const idx = state.sessions.findIndex((s) => !s.pinned)
    if (idx >= 0) state.sessions.splice(idx, 1)
    else {
      toast(`会话数量已达上限 ${LIMITS.sessions}`, 'warn')
      return null
    }
  }
  const conn = getConnection(connectionId)
  const session = {
    id: uid('sess'),
    name: name || conn?.name || '控制台',
    connectionId: connectionId || state.connections[0]?.id || '',
    database: database || conn?.database,
    schema: schema || conn?.schema,
    activeEditorId: '',
    editors: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pinned: false
  }
  createEditorTab(session)
  state.sessions.unshift(session)
  state.activeSessionId = session.id
  schedulePersistSessions()
  persistNow(StorageKeys.activeSessionId, state.activeSessionId)
  return session
}

export function setActiveSession(id) {
  if (!state.sessions.some((s) => s.id === id)) return
  state.activeSessionId = id
  schedulePersistSessions()
  persistNow(StorageKeys.activeSessionId, id)
}

export function updateSessionEditorSql(editor, sql, cursor) {
  editor.sql = String(sql ?? '').slice(0, LIMITS.sqlBytes)
  if (cursor) editor.cursor = cursor
  editor.dirty = true
  const s = activeSession()
  if (s) {
    s.updatedAt = Date.now()
    schedulePersistSessions()
  }
}

export function schedulePersistSessions() {
  schedulePersist(StorageKeys.sessions, state.sessions, 800)
}

export function saveSessionsImmediate() {
  return persistNow(StorageKeys.sessions, state.sessions).then(() => persistNow(StorageKeys.activeSessionId, state.activeSessionId))
}

export function renameSession(id, name) {
  const s = state.sessions.find((x) => x.id === id)
  if (!s) return
  s.name = String(name || '').trim() || s.name
  s.updatedAt = Date.now()
  schedulePersistSessions()
}

export function togglePinSession(id) {
  const s = state.sessions.find((x) => x.id === id)
  if (!s) return
  s.pinned = !s.pinned
  s.updatedAt = Date.now()
  state.sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
  schedulePersistSessions()
}

export function deleteSession(id) {
  state.sessions = state.sessions.filter((s) => s.id !== id)
  if (state.activeSessionId === id) {
    state.activeSessionId = state.sessions[0]?.id || null
  }
  schedulePersistSessions()
  persistNow(StorageKeys.activeSessionId, state.activeSessionId)
}

export function duplicateSession(id) {
  const s = state.sessions.find((x) => x.id === id)
  if (!s) return null
  const copy = JSON.parse(JSON.stringify(s))
  copy.id = uid('sess')
  copy.name = `${s.name}-副本`
  copy.createdAt = Date.now()
  copy.updatedAt = Date.now()
  copy.pinned = false
  copy.editors = (copy.editors || []).map((e) => ({ ...e, id: uid('ed') }))
  copy.activeEditorId = copy.editors[0]?.id || ''
  state.sessions.unshift(copy)
  state.activeSessionId = copy.id
  schedulePersistSessions()
  return copy
}

export function closeEditorTab(session, editorId) {
  const idx = (session.editors || []).findIndex((e) => e.id === editorId)
  if (idx < 0) return
  const ed = session.editors[idx]
  if (ed.dirty && ed.sql.trim()) {
    if (!window.confirm(`「${ed.title}」有未保存内容，确定关闭？`)) return
  }
  session.editors.splice(idx, 1)
  if (session.activeEditorId === editorId) {
    session.activeEditorId = session.editors[Math.max(0, idx - 1)]?.id || ''
  }
  if (!session.editors.length) createEditorTab(session)
  state.results.delete(editorId)
  session.updatedAt = Date.now()
  schedulePersistSessions()
}

/* ── query history ── */

export function pushHistory(entry) {
  const item = {
    id: uid('qh'),
    connectionId: entry.connectionId,
    sql: entry.sql,
    durationMs: entry.durationMs,
    rowCount: entry.rowCount,
    ts: Date.now(),
    error: entry.error,
    sessionName: entry.sessionName,
    pinned: false
  }
  state.queryHistory.unshift(item)
  if (state.queryHistory.length > LIMITS.history) {
    const keep = []
    let count = 0
    for (const h of state.queryHistory) {
      if (h.pinned || count < LIMITS.history - 1) {
        keep.push(h)
        count++
      }
      if (keep.length >= LIMITS.history) break
    }
    state.queryHistory = keep
  }
  schedulePersist(StorageKeys.queryHistory, state.queryHistory, 400)
  return item
}

/* ── completion usage ── */

export function bumpCompletionUsage(kind, owner, label) {
  if (state.ui.learnUsage === false) return
  const key = `${kind}:${owner || ''}.${label}`
  state.completionUsage[key] = (state.completionUsage[key] || 0) + 1
  schedulePersist(StorageKeys.completionUsage, state.completionUsage, 1200)
}

export function usageScore(kind, owner, label) {
  return state.completionUsage[`${kind}:${owner || ''}.${label}`] || 0
}

/* ── ui prefs ── */

export function setUiPref(key, value) {
  state.ui[key] = value
  schedulePersist(StorageKeys.ui, state.ui, 300)
}

/* ── results helpers ── */

export function getResultState(editorId) {
  if (!state.results.has(editorId)) {
    state.results.set(editorId, {
      tabs: [],
      activeTab: 0,
      tableRefOverride: null,
      message: '',
      error: ''
    })
  }
  return state.results.get(editorId)
}

export function clearResults(editorId) {
  state.results.delete(editorId)
}

export { LIMITS, uid }
