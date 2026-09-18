/**
 * com.enest.ssh — 状态与 KV 持久化（Spec 2.0 / SSH-H）
 * 键：ssh.profiles | ssh.groups | ssh.history | ssh.snippets | ssh.ui
 */
;(function (global) {
  const KEYS = {
    profiles: 'ssh.profiles',
    groups: 'ssh.groups',
    history: 'ssh.history',
    snippets: 'ssh.snippets',
    ui: 'ssh.ui',
  }

  const HISTORY_MAX = 2000

  function uid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
  }

  function clone(v) {
    return v == null ? v : JSON.parse(JSON.stringify(v))
  }

  const defaultUi = () => ({
    collapsedGroups: {},
    fontSize: 13,
    selectCopy: true,
    recordHistory: true,
    search: '',
    filterEnv: '',
    filterTag: '',
    filterFavorite: false,
    filterRecent: false,
    viewMode: 'tree',
    sortBy: 'name',
    selectedGroupId: '',
    selectedProfileId: '',
    openProfileIds: [],
    rightTab: 'history',
    centerTab: 'term',
    historyScope: 'current',
    historyQuery: '',
    historyRegex: false,
    monitorOn: false,
    monitorIntervalMs: 5000,
    warnThreshold: 85,
    dangerThreshold: 95,
    autoReconnect: false,
    dangerExempt: {},
    maskHistory: true,
    /* UI chrome */
    sidebarCollapsed: false,
    drawerOpen: false,
    rightOpen: false,
  })

  const state = {
    profiles: [],
    groups: [],
    history: [],
    snippets: [],
    ui: defaultUi(),
    _dirty: {},
    _timers: {},
  }

  function mergeUi(raw) {
    return { ...defaultUi(), ...(raw && typeof raw === 'object' ? raw : {}) }
  }

  async function loadAll() {
    const api = global.SshApi
    const [profiles, groups, history, snippets, ui] = await Promise.all([
      api.storageGet(KEYS.profiles, []),
      api.storageGet(KEYS.groups, []),
      api.storageGet(KEYS.history, []),
      api.storageGet(KEYS.snippets, []),
      api.storageGet(KEYS.ui, null),
    ])
    state.profiles = Array.isArray(profiles) ? profiles : []
    state.groups = Array.isArray(groups) ? groups : []
    state.history = Array.isArray(history) ? history : []
    state.snippets = Array.isArray(snippets) ? snippets : []
    state.ui = mergeUi(ui)

    if (!state.snippets.length && global.SshDict?.DEFAULT_SNIPPETS) {
      state.snippets = clone(global.SshDict.DEFAULT_SNIPPETS)
      queueSave('snippets')
    }
    return state
  }

  function payloadFor(key) {
    switch (key) {
      case 'profiles': return state.profiles
      case 'groups': return state.groups
      case 'history': return state.history
      case 'snippets': return state.snippets
      case 'ui': return state.ui
      default: return null
    }
  }

  function queueSave(key, immediate) {
    state._dirty[key] = true
    const run = async () => {
      if (!state._dirty[key]) return
      state._dirty[key] = false
      try {
        await global.SshApi.storageSet(KEYS[key], clone(payloadFor(key)))
      } catch (e) {
        global.SshApi.toast('持久化失败 ' + KEYS[key] + '：' + global.SshApi.errMessage(e), 'error')
      }
    }
    if (state._timers[key]) clearTimeout(state._timers[key])
    if (immediate) {
      return run()
    }
    state._timers[key] = setTimeout(() => {
      state._timers[key] = null
      void run()
    }, 300)
  }

  async function flushAll() {
    for (const key of Object.keys(KEYS)) {
      if (state._timers[key]) {
        clearTimeout(state._timers[key])
        state._timers[key] = null
      }
      state._dirty[key] = true
      try {
        await global.SshApi.storageSet(KEYS[key], clone(payloadFor(key)))
        state._dirty[key] = false
      } catch (e) {
        global.SshApi.toast('保存失败：' + global.SshApi.errMessage(e), 'error')
      }
    }
  }

  function findProfile(id) {
    return state.profiles.find((p) => p.id === id) || null
  }

  function findGroup(id) {
    return state.groups.find((g) => g.id === id) || null
  }

  function childrenOf(parentId) {
    return state.groups
      .filter((g) => (g.parentId || '') === (parentId || ''))
      .sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.name).localeCompare(String(b.name)))
  }

  function profilesInGroup(groupId) {
    return state.profiles
      .filter((p) => (p.groupId || '') === (groupId || ''))
      .sort(sortProfiles)
  }

  function sortProfiles(a, b) {
    const mode = state.ui.sortBy
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
    if (mode === 'lastConnected') {
      return (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0)
    }
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh')
  }

  function allTags() {
    const set = new Set()
    for (const p of state.profiles) {
      for (const t of p.tags || []) set.add(t)
    }
    return Array.from(set).sort()
  }

  function matchesFilters(profile) {
    const q = (state.ui.search || '').trim().toLowerCase()
    if (q) {
      const hay = [
        profile.name,
        profile.host,
        profile.username,
        profile.note,
        profile.env,
        ...(profile.tags || []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      if (!hay.includes(q)) return false
    }
    if (state.ui.filterEnv && profile.env !== state.ui.filterEnv) return false
    if (state.ui.filterTag && !(profile.tags || []).includes(state.ui.filterTag)) return false
    if (state.ui.filterFavorite && !profile.favorite) return false
    if (state.ui.filterRecent) {
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000
      if (!(profile.lastConnectedAt && profile.lastConnectedAt >= cutoff)) return false
    }
    return true
  }

  function pushHistory(entry) {
    if (!state.ui.recordHistory) return
    let cmd = entry.command || ''
    if (state.ui.maskHistory) cmd = maskCommand(cmd)
    const item = {
      id: uid('hist'),
      profileId: entry.profileId || '',
      command: cmd,
      exitCode: entry.exitCode,
      durationMs: entry.durationMs,
      ts: entry.ts || Date.now(),
      tags: entry.tags || [],
      pinned: false,
    }
    state.history.unshift(item)
    // LRU：优先淘汰非 pinned
    if (state.history.length > HISTORY_MAX) {
      const pinned = state.history.filter((h) => h.pinned)
      const rest = state.history.filter((h) => !h.pinned)
      state.history = pinned.concat(rest.slice(0, HISTORY_MAX - pinned.length))
    }
    queueSave('history')
  }

  function maskCommand(cmd) {
    return String(cmd)
      .replace(/(password|passwd|pwd|token|secret|authorization)\s*[=:]\s*\S+/gi, '$1=***')
      .replace(/(-p|--password[= ])\S+/gi, '$1***')
      .replace(/\b[A-Za-z0-9_-]{20,}\b/g, (m) => (/^[A-Za-z0-9_-]+$/.test(m) && m.length >= 28 ? '***' : m))
  }

  function upsertProfile(profile) {
    const idx = state.profiles.findIndex((p) => p.id === profile.id)
    if (idx >= 0) state.profiles[idx] = profile
    else state.profiles.push(profile)
    queueSave('profiles', true)
  }

  function removeProfile(id) {
    state.profiles = state.profiles.filter((p) => p.id !== id)
    queueSave('profiles', true)
  }

  function upsertGroup(group) {
    const idx = state.groups.findIndex((g) => g.id === group.id)
    if (idx >= 0) state.groups[idx] = group
    else state.groups.push(group)
    queueSave('groups', true)
  }

  function removeGroup(id, mode) {
    // mode: orphan | cascade
    const ids = new Set([id])
    let changed = true
    while (changed) {
      changed = false
      for (const g of state.groups) {
        if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
          ids.add(g.id)
          changed = true
        }
      }
    }
    if (mode === 'cascade') {
      state.profiles = state.profiles.filter((p) => !ids.has(p.groupId || ''))
      queueSave('profiles', true)
    } else {
      state.profiles = state.profiles.map((p) =>
        ids.has(p.groupId || '') ? { ...p, groupId: '' } : p
      )
      queueSave('profiles', true)
    }
    state.groups = state.groups.filter((g) => !ids.has(g.id))
    queueSave('groups', true)
  }

  function upsertSnippet(snip) {
    const idx = state.snippets.findIndex((s) => s.id === snip.id)
    if (idx >= 0) state.snippets[idx] = snip
    else state.snippets.push(snip)
    queueSave('snippets', true)
  }

  function removeSnippet(id) {
    state.snippets = state.snippets.filter((s) => s.id !== id)
    queueSave('snippets', true)
  }

  function setUi(patch, immediate) {
    Object.assign(state.ui, patch)
    queueSave('ui', immediate)
  }

  global.SshStore = {
    KEYS,
    state,
    uid,
    clone,
    loadAll,
    queueSave,
    flushAll,
    findProfile,
    findGroup,
    childrenOf,
    profilesInGroup,
    allTags,
    matchesFilters,
    sortProfiles,
    pushHistory,
    maskCommand,
    upsertProfile,
    removeProfile,
    upsertGroup,
    removeGroup,
    upsertSnippet,
    removeSnippet,
    setUi,
  }
})(window)
