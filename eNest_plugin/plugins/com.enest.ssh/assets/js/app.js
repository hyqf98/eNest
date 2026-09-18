/**
 * com.enest.ssh — minimalist UI shell
 * Storage keys unchanged: ssh.profiles/groups/history/snippets/ui
 * API: enest.ssh.* · vault secretRef · settings.register followShellTheme
 */
;(function () {
  const api = window.SshApi
  const store = window.SshStore
  const dict = window.SshDict
  const Term = window.SshTerm
  const $ = (id) => document.getElementById(id)

  const sessions = new Map()
  let activeSessionId = null
  let completionState = { items: [], index: 0, open: false }
  let completionTimer = null
  const pathCache = new Map()
  let hostSshReady = false
  let followShellTheme = true
  let ctxCloseHandler = null

  /* ========== utils ========== */
  function toast(msg, type) {
    api.toast(msg, type)
  }
  function err(e) {
    return api.errMessage(e)
  }
  function isPerm(e) {
    return String(err(e)).includes('permission denied')
  }
  function fmtTime(ts) {
    if (!ts) return '—'
    try {
      return new Date(ts).toLocaleString()
    } catch {
      return String(ts)
    }
  }
  function fmtRelTime(ts) {
    if (!ts) return ''
    const diff = Date.now() - ts
    if (diff < 60e3) return '刚刚'
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前'
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前'
    if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前'
    return fmtTime(ts)
  }
  function envClass(env) {
    if (env === 'prod') return 'badge env-prod'
    if (env === 'staging') return 'badge env-staging'
    if (env === 'dev') return 'badge env-dev'
    return 'badge'
  }
  function statusLabel(st) {
    return (
      {
        connecting: '连接中',
        connected: '已连接',
        disconnected: '已断开',
        exited: '已退出',
      }[st] || st || ''
    )
  }
  function profileTitle(p) {
    return p.name || p.username + '@' + p.host
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /* ========== context menu ========== */
  function closeContextMenu() {
    const menu = $('ctx-menu')
    if (menu) {
      menu.classList.remove('show')
      menu.hidden = true
      menu.innerHTML = ''
    }
    if (ctxCloseHandler) {
      document.removeEventListener('click', ctxCloseHandler, true)
      document.removeEventListener('keydown', ctxCloseHandler, true)
      document.removeEventListener('contextmenu', ctxCloseHandler, true)
      ctxCloseHandler = null
    }
  }

  function showContextMenu(x, y, items) {
    const menu = $('ctx-menu')
    if (!menu || !items || !items.length) return
    closeContextMenu()

    const html = items
      .map((it, i) => {
        if (it.sep) return '<div class="ctx-sep"></div>'
        if (it.title) return '<div class="ctx-label">' + escapeHtml(it.title) + '</div>'
        const cls = 'ctx-item' + (it.danger ? ' danger' : '') + (it.primary ? ' primary' : '')
        return (
          '<button type="button" class="' +
          cls +
          '" data-idx="' +
          i +
          '" role="menuitem"' +
          (it.disabled ? ' disabled' : '') +
          ' title="' +
          escapeHtml(it.label || '') +
          '">' +
          escapeHtml(it.label || '') +
          '</button>'
        )
      })
      .join('')
    menu.innerHTML = html
    menu.hidden = false
    menu.classList.add('show')

    const vw = window.innerWidth
    const vh = window.innerHeight
    menu.style.left = '0px'
    menu.style.top = '0px'
    const rect = menu.getBoundingClientRect()
    let left = x
    let top = y
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'

    menu.onclick = (ev) => {
      const btn = ev.target.closest('.ctx-item')
      if (!btn || btn.disabled) return
      const item = items[Number(btn.dataset.idx)]
      closeContextMenu()
      if (item && typeof item.onAct === 'function') void item.onAct()
    }

    ctxCloseHandler = (ev) => {
      if (menu.contains(ev.target)) return
      closeContextMenu()
    }
    setTimeout(() => {
      document.addEventListener('click', ctxCloseHandler, true)
      document.addEventListener('keydown', ctxCloseHandler, true)
      document.addEventListener('contextmenu', ctxCloseHandler, true)
    }, 0)
  }

  function showMenuFromEl(el, items) {
    if (!el) return
    const r = el.getBoundingClientRect()
    showContextMenu(r.left, r.bottom + 4, items)
  }

  function bindCtx(el, builder) {
    if (!el) return
    el.oncontextmenu = (ev) => {
      const items = typeof builder === 'function' ? builder(ev) : builder
      if (!items || !items.length) return
      ev.preventDefault()
      ev.stopPropagation()
      showContextMenu(ev.clientX, ev.clientY, items)
    }
  }

  /* ========== sidebar / drawer / FAB ========== */
  function setSidebarCollapsed(collapsed, persist) {
    const app = $('app')
    const side = $('sidebar')
    const isCollapsed = !!collapsed
    if (app) app.classList.toggle('side-collapsed', isCollapsed)
    if (side) side.dataset.collapsed = isCollapsed ? '1' : '0'
    if (persist !== false) store.setUi({ sidebarCollapsed: isCollapsed })
  }

  function toggleSidebar() {
    const side = $('sidebar')
    const collapsed = side ? side.dataset.collapsed === '1' : false
    setSidebarCollapsed(!collapsed)
  }

  function setDrawerOpen(open, persist) {
    const drawer = $('drawer')
    const scrim = $('drawer-scrim')
    const isOpen = !!open
    if (drawer) {
      drawer.classList.toggle('open', isOpen)
      drawer.setAttribute('aria-hidden', isOpen ? 'false' : 'true')
    }
    if (scrim) scrim.hidden = !isOpen
    document.querySelectorAll('#btn-top-drawer, #rail-drawer').forEach((b) => {
      if (b) b.classList.toggle('active', isOpen)
    })
    if (persist !== false) store.setUi({ drawerOpen: isOpen })
  }

  function toggleDrawer() {
    const drawer = $('drawer')
    const open = drawer ? !drawer.classList.contains('open') : true
    setDrawerOpen(open)
  }

  function updateFab() {
    const fab = $('fab')
    if (!fab) return
    const s = activeSession()
    const selected = store.state.ui.selectedProfileId
    const hasProfile = !!(selected && store.findProfile(selected)) || store.state.profiles.length > 0
    const canTerm = !!(
      (s && (s.status === 'connected' || s.status === 'connecting' || s.sessionId)) ||
      (selected && store.findProfile(selected)) ||
      (hasProfile && store.state.profiles.length)
    )
    const tips = window.EnestTips
    if (canTerm) {
      const label = '打开终端'
      if (tips) tips.setTip(fab, label)
      else {
        fab.title = label
        fab.setAttribute('aria-label', label)
      }
      fab.textContent = '⌘'
      fab.dataset.mode = 'term'
    } else {
      const label = '新建连接'
      if (tips) tips.setTip(fab, label)
      else {
        fab.title = label
        fab.setAttribute('aria-label', label)
      }
      fab.textContent = '+'
      fab.dataset.mode = 'new'
    }
  }

  async function fabAction() {
    const fab = $('fab')
    const mode = fab && fab.dataset.mode === 'term' ? 'term' : 'new'
    if (mode === 'new') {
      openProfileForm(null)
      return
    }
    const id = store.state.ui.selectedProfileId
    const p = id ? store.findProfile(id) : store.state.profiles[0]
    if (!p) {
      openProfileForm(null)
      return
    }
    store.setUi({ selectedProfileId: p.id, centerTab: 'term' })
    renderCenterTabs()
    await connectProfile(p)
  }

  /* ========== top status ========== */
  function renderTopStatus() {
    const s = activeSession()
    const nameEl = $('top-name')
    const subEl = $('top-sub')
    const dot = $('top-dot')
    if (!nameEl) return
    if (s) {
      const p = store.findProfile(s.profileId)
      nameEl.textContent = p ? profileTitle(p) : s.profileId
      const bits = []
      const st = statusLabel(s.status)
      if (st) bits.push(st)
      if (p && p.host) bits.push((p.username || '') + '@' + p.host)
      if (subEl) subEl.textContent = bits.join(' · ')
      if (dot) {
        dot.className = 'status-dot ' + (s.status || '')
      }
    } else {
      nameEl.textContent = 'SSH'
      if (subEl) subEl.textContent = store.state.profiles.length ? store.state.profiles.length + ' 连接' : ''
      if (dot) dot.className = 'status-dot'
    }
    updateFab()
  }

  /* ========== selection toolbar ========== */
  function renderSelBar() {
    const bar = $('sel-bar')
    if (!bar) return
    const id = store.state.ui.selectedProfileId
    const p = id ? store.findProfile(id) : null
    if (!p) {
      bar.hidden = true
      bar.innerHTML = ''
      return
    }
    bar.hidden = false
    bar.innerHTML =
      '<span class="sel-name">' +
      escapeHtml(profileTitle(p)) +
      '</span>' +
      '<button class="icon-btn" data-sel="connect" title="连接" aria-label="连接" data-tip="连接">↗</button>' +
      '<button class="icon-btn" data-sel="edit" title="编辑" aria-label="编辑" data-tip="编辑">✎</button>' +
      '<button class="icon-btn" data-sel="more" title="更多操作" aria-label="更多操作" data-tip="更多操作">⋯</button>'
    bar.onclick = (ev) => {
      const b = ev.target.closest('[data-sel]')
      if (!b) return
      const act = b.dataset.sel
      if (act === 'connect') void actions.connectProfileById(p.id)
      else if (act === 'edit') actions.editProfile(p.id)
      else if (act === 'more') showMenuFromEl(b, profileMenuItems(p.id) || [])
    }
  }

  /* ========== actions ========== */
  const actions = {
    async connectProfileById(id) {
      const profile = store.findProfile(id)
      store.setUi({ selectedProfileId: id, centerTab: 'term' })
      renderCenterTabs()
      if (profile) await connectProfile(profile)
      else toast('连接配置不存在', 'error')
    },
    editProfile(id) {
      const profile = store.findProfile(id)
      if (profile) openProfileForm(profile)
    },
    duplicateProfile(id) {
      const profile = store.findProfile(id)
      if (!profile) return
      const copy = {
        ...store.clone(profile),
        id: store.uid('prof'),
        name: (profile.name || '连接') + ' 副本',
        secretRef: undefined,
        favorite: false,
        lastConnectedAt: undefined,
      }
      store.upsertProfile(copy)
      renderLeft()
      toast('已复制', 'success')
    },
    toggleFavorite(id) {
      const profile = store.findProfile(id)
      if (!profile) return
      store.upsertProfile({ ...profile, favorite: !profile.favorite })
      renderLeft()
    },
    async deleteProfile(id) {
      const profile = store.findProfile(id)
      if (!profile) return
      const ok = await confirmDialog('删除「' + profile.name + '」？', {
        title: '删除连接',
        okText: '删除',
        danger: true,
      })
      if (!ok) return
      if (profile.secretRef) {
        try {
          await api.vaultRemove(profile.secretRef)
        } catch {
          /* ignore */
        }
      }
      store.removeProfile(id)
      if (store.state.ui.selectedProfileId === id) store.setUi({ selectedProfileId: '' })
      renderLeft()
      renderTopStatus()
      toast('已删除', 'success')
    },
    async copySshCommand(id) {
      const profile = store.findProfile(id)
      if (!profile) return
      const cmd =
        'ssh ' +
        (profile.username ? profile.username + '@' : '') +
        profile.host +
        (profile.port && profile.port !== 22 ? ' -p ' + profile.port : '')
      try {
        await api.copyText(cmd)
        toast('已复制', 'success')
      } catch (e) {
        toast(err(e), 'error')
      }
    },
    async moveProfileToGroup(id) {
      const profile = store.findProfile(id)
      if (!profile) return
      const flat = []
      const walk = (parentId, depth) => {
        for (const g of store.childrenOf(parentId)) {
          flat.push({ id: g.id, name: '　'.repeat(depth) + g.name, plain: g.name })
          walk(g.id, depth + 1)
        }
      }
      walk('', 0)
      const hint = flat.length ? flat.map((g) => g.plain).join(' / ') : '未分组'
      const name = await promptDialog('移动到分组', hint, '')
      if (name == null) return
      const trimmed = String(name).trim()
      if (!trimmed) {
        store.upsertProfile({ ...profile, groupId: '' })
        renderLeft()
        return
      }
      const target = flat.find((g) => g.plain === trimmed || g.name === name)
      if (!target) {
        toast('未找到分组', 'warn')
        return
      }
      store.upsertProfile({ ...profile, groupId: target.id })
      renderLeft()
    },
    async exportOneProfile(id) {
      const profile = store.findProfile(id)
      if (!profile) return
      const copy = store.clone(profile)
      delete copy.secretRef
      if (copy.jump) copy.jump = { ...copy.jump, secretRef: undefined }
      downloadJson('enest-ssh-' + (profile.name || profile.id) + '.json', {
        format: 'enest.ssh.export',
        version: 1,
        exportedAt: new Date().toISOString(),
        profiles: [copy],
        groups: [],
      })
    },
    async openTerminalFor(id) {
      const profile = store.findProfile(id)
      if (!profile) {
        toast('连接配置不存在', 'error')
        return
      }
      store.setUi({ selectedProfileId: id, centerTab: 'term' })
      renderCenterTabs()
      await connectProfile(profile)
    },
    viewHistoryFor(id) {
      store.setUi({
        rightTab: 'history',
        drawerOpen: true,
        historyScope: 'current',
        selectedProfileId: id || store.state.ui.selectedProfileId,
      })
      setDrawerOpen(true, false)
      const scope = $('right-scope')
      if (scope) scope.value = 'current'
      const s = Array.from(sessions.values()).find((x) => x.profileId === id)
      if (s) setActiveTab(s.tabId)
      renderRight()
    },
    async toggleMetricsFor(id) {
      let s = Array.from(sessions.values()).find((x) => x.profileId === id)
      if (!s) {
        const p = store.findProfile(id)
        if (!p) return
        s = ensureSession(p.id)
      }
      if (s.tabId !== activeSessionId) setActiveTab(s.tabId)
      store.setUi({ centerTab: 'metrics' })
      renderCenterTabs()
      if (s.metricsOn) {
        await stopMetrics(s)
        store.setUi({ monitorOn: false })
      } else if (s.sessionId) {
        store.setUi({ monitorIntervalMs: Number($('metrics-interval')?.value) || 5000 })
        await startMetrics(s)
      } else {
        toast('请先连接', 'warn')
      }
      renderMetrics()
    },
    openSftpFor(id) {
      const s = Array.from(sessions.values()).find((x) => x.profileId === id)
      if (s) setActiveTab(s.tabId)
      store.setUi({ centerTab: 'sftp' })
      renderCenterTabs()
      renderSftp()
    },
  }

  function profileMenuItems(profileId) {
    const p = store.findProfile(profileId)
    if (!p) return null
    return [
      { primary: true, label: '连接', onAct: () => void actions.connectProfileById(profileId) },
      { label: '终端', onAct: () => void actions.openTerminalFor(profileId) },
      { label: '编辑', onAct: () => actions.editProfile(profileId) },
      { label: '复制', onAct: () => actions.duplicateProfile(profileId) },
      { label: '删除', danger: true, onAct: () => void actions.deleteProfile(profileId) },
      { sep: true },
      { label: '历史', onAct: () => actions.viewHistoryFor(profileId) },
      {
        label: p.favorite ? '取消收藏' : '收藏',
        onAct: () => actions.toggleFavorite(profileId),
      },
      { label: '移动分组', onAct: () => void actions.moveProfileToGroup(profileId) },
      { label: '复制命令', onAct: () => void actions.copySshCommand(profileId) },
      { label: '监控', onAct: () => void actions.toggleMetricsFor(profileId) },
      { label: 'SFTP', onAct: () => actions.openSftpFor(profileId) },
      { label: '导出', onAct: () => void actions.exportOneProfile(profileId) },
    ]
  }

  function groupMenuItems(groupId) {
    const g = groupId ? store.findGroup(groupId) : null
    const items = [
      {
        primary: true,
        label: '新建连接',
        onAct: () => {
          store.setUi({ selectedGroupId: groupId || '' })
          openProfileForm(null)
        },
      },
    ]
    if (g) {
      items.push(
        { sep: true },
        {
          label: '新建子组',
          onAct: async () => {
            const name = await promptDialog('新建子分组', '名称', '')
            if (!name) return
            store.upsertGroup({
              id: store.uid('grp'),
              name,
              parentId: g.id,
              color: '',
              sort: store.state.groups.length,
              collapsed: false,
            })
            renderLeft()
          },
        },
        {
          label: '重命名',
          onAct: async () => {
            const name = await promptDialog('重命名分组', '', g.name)
            if (!name) return
            store.upsertGroup({ ...g, name })
            renderLeft()
          },
        },
        {
          label: '删除分组',
          danger: true,
          onAct: async () => {
            const childCount = store.state.profiles.filter((p) => {
              const ids = new Set([groupId])
              let ch = true
              while (ch) {
                ch = false
                for (const gg of store.state.groups) {
                  if (gg.parentId && ids.has(gg.parentId) && !ids.has(gg.id)) {
                    ids.add(gg.id)
                    ch = true
                  }
                }
              }
              return ids.has(p.groupId || '')
            }).length
            const orphan = await confirmDialog('删除分组？连接将移入未分组。', {
              title: '删除分组',
              okText: '删除并移动',
              cancelText: '取消',
            })
            if (orphan === true) {
              store.removeGroup(groupId, 'orphan')
            } else if (orphan === false) {
              const cascade = await confirmDialog('级联删除分组及其 ' + childCount + ' 个连接？', {
                title: '级联删除',
                okText: '级联删除',
                danger: true,
              })
              if (!cascade) return
              store.removeGroup(groupId, 'cascade')
            } else {
              return
            }
            renderLeft()
          },
        }
      )
    } else {
      items.push(
        { sep: true },
        {
          label: '新建分组',
          onAct: async () => {
            const name = await promptDialog('新建分组', '名称', '')
            if (!name) return
            store.upsertGroup({
              id: store.uid('grp'),
              name,
              parentId: '',
              color: '',
              sort: store.state.groups.length,
              collapsed: false,
            })
            renderLeft()
          },
        }
      )
    }
    return items
  }

  function sessionTabMenuItems(tabId) {
    const s = sessions.get(tabId)
    if (!s) return null
    return [
      {
        primary: true,
        label: s.status === 'connected' ? '重连' : '连接',
        onAct: () => void connectActive(true),
      },
      { label: '终端', onAct: () => void actions.openTerminalFor(s.profileId) },
      {
        label: '断开',
        disabled: !s.sessionId,
        onAct: async () => {
          await disconnectSession(s)
        },
      },
      { label: '关闭', danger: true, onAct: () => void closeTab(tabId) },
      { sep: true },
      { label: '历史', onAct: () => actions.viewHistoryFor(s.profileId) },
      { label: '监控', onAct: () => void actions.toggleMetricsFor(s.profileId) },
      { label: 'SFTP', onAct: () => actions.openSftpFor(s.profileId) },
    ]
  }

  function historyItemMenuItems(histId) {
    const h = store.state.history.find((x) => x.id === histId)
    if (!h) return null
    return [
      { primary: true, label: '填入', onAct: () => void fillHint(h.command) },
      { label: '执行', onAct: () => void runHint(h.command) },
      {
        label: '复制',
        onAct: async () => {
          try {
            await api.copyText(h.command || '')
          } catch (e) {
            toast(err(e), 'error')
          }
        },
      },
      { sep: true },
      {
        label: '删除',
        danger: true,
        onAct: () => {
          store.state.history = store.state.history.filter((x) => x.id !== histId)
          store.queueSave('history', true)
          renderRight()
        },
      },
    ]
  }

  function snippetMenuItems(snipId) {
    const s = store.state.snippets.find((x) => x.id === snipId)
    if (!s) return null
    return [
      { primary: true, label: '填入', onAct: () => void fillHint(s.command) },
      { label: '执行', onAct: () => void runHint(s.command) },
      { sep: true },
      {
        label: '编辑',
        onAct: async () => {
          const title = await promptDialog('标题', '', s.title)
          const command = await promptDialog('命令', '', s.command)
          if (command == null) return
          store.upsertSnippet({ ...s, title: title || s.title, command: command || s.command })
          renderRight()
        },
      },
      {
        label: '复制',
        onAct: async () => {
          try {
            await api.copyText(s.command || '')
          } catch (e) {
            toast(err(e), 'error')
          }
        },
      },
      { sep: true },
      {
        label: '删除',
        danger: true,
        onAct: async () => {
          if (!(await confirmDialog('删除常用命令？', { title: '删除', danger: true }))) return
          store.removeSnippet(snipId)
          renderRight()
        },
      },
    ]
  }

  function sideMoreItems() {
    return [
      { primary: true, label: '新建连接', onAct: () => openProfileForm(null) },
      { label: '新建分组', onAct: () => void newGroup() },
      { sep: true },
      {
        label: store.state.ui.filterFavorite ? '取消收藏筛选' : '仅收藏',
        onAct: () => {
          store.setUi({ filterFavorite: !store.state.ui.filterFavorite })
          renderLeft()
        },
      },
      {
        label: store.state.ui.filterRecent ? '取消最近筛选' : '最近连接',
        onAct: () => {
          store.setUi({ filterRecent: !store.state.ui.filterRecent })
          renderLeft()
        },
      },
      { sep: true },
      { label: '历史', onAct: () => toggleDrawer() },
      { label: '导出', onAct: () => void exportAssets(true) },
      { label: '导入', onAct: () => void importAssets() },
    ]
  }

  function topMoreItems() {
    const s = activeSession()
    return [
      { primary: true, label: '新建连接', onAct: () => openProfileForm(null) },
      {
        label: '打开终端',
        disabled: !store.state.profiles.length,
        onAct: () => void fabAction(),
      },
      { label: '历史', onAct: () => toggleDrawer() },
      { sep: true },
      {
        label: '重连',
        disabled: !s,
        onAct: () => void connectActive(true),
      },
      {
        label: '断开',
        disabled: !(s && s.sessionId),
        onAct: async () => {
          if (!s) return
          await disconnectSession(s)
        },
      },
      { sep: true },
      {
        label: '监控',
        disabled: !s,
        onAct: () => {
          if (!s) return
          store.setUi({ centerTab: 'metrics' })
          renderCenterTabs()
          renderMetrics()
        },
      },
      {
        label: 'SFTP',
        disabled: !s,
        onAct: () => {
          if (!s) return
          store.setUi({ centerTab: 'sftp' })
          renderCenterTabs()
          renderSftp()
        },
      },
      { label: '字号 +', onAct: () => bumpFont(1) },
      { label: '字号 −', onAct: () => bumpFont(-1) },
      { sep: true },
      { label: '导出', onAct: () => void exportAssets(true) },
      { label: '导入', onAct: () => void importAssets() },
    ]
  }

  function hintMoreItems() {
    const s = activeSession()
    return [
      { primary: true, label: '补全', onAct: () => void runCompletion(true) },
      { sep: true },
      {
        label: '重连',
        disabled: !s,
        onAct: () => void connectActive(true),
      },
      {
        label: '断开',
        disabled: !(s && s.sessionId),
        onAct: async () => {
          if (!s) return
          await disconnectSession(s)
        },
      },
      {
        label: '清屏',
        disabled: !s?.term,
        onAct: () => {
          s?.term?.clear?.()
        },
      },
      {
        label: '复制输出',
        disabled: !s,
        onAct: () => void copyTerm(),
      },
    ]
  }

  function drawerMoreItems() {
    return [
      {
        primary: true,
        label: '新建常用',
        onAct: async () => {
          const title = await promptDialog('标题', '', '')
          if (title == null) return
          const command = await promptDialog('命令', '', '')
          if (!command) return
          store.upsertSnippet({
            id: store.uid('snip'),
            title,
            command,
            tags: [],
            sort: store.state.snippets.length,
            pinned: false,
          })
          store.setUi({ rightTab: 'snippets' })
          renderRight()
        },
      },
      { label: '导出常用', onAct: () => void exportSnippets() },
      { sep: true },
      {
        label: '清空历史',
        danger: true,
        onAct: () => void clearHistory(),
      },
    ]
  }

  function sftpMoreItems() {
    return [
      { primary: true, label: '刷新', onAct: () => void sftpRefresh() },
      { label: '上传', onAct: () => void sftpUpload() },
      { label: '下载', onAct: () => void sftpDownload() },
    ]
  }

  async function newGroup() {
    const name = await promptDialog('新建分组', '名称', '')
    if (!name) return
    store.upsertGroup({
      id: store.uid('grp'),
      name,
      parentId: store.state.ui.selectedGroupId || '',
      color: '',
      sort: store.state.groups.length,
      collapsed: false,
    })
    renderLeft()
  }

  function bumpFont(delta) {
    const next = Math.max(10, Math.min(24, (Number(store.state.ui.fontSize) || 13) + delta))
    store.setUi({ fontSize: next }, true)
    for (const s of sessions.values()) s.term?.setFontSize?.(next)
  }

  async function copyTerm() {
    const s = activeSession()
    const text = s?.term?.getSelection?.() || s?.buffer || ''
    if (!text) {
      toast('无可复制内容', 'warn')
      return
    }
    try {
      await api.copyText(text)
    } catch (e) {
      toast(err(e), 'error')
    }
  }

  async function clearHistory() {
    const scope = store.state.ui.historyScope
    const pid = activeSession()?.profileId
    const msg = scope === 'current' && pid ? '清空当前连接历史？' : '清空全部历史？'
    if (!(await confirmDialog(msg, { title: '清空历史', danger: true, okText: '清空' }))) return
    if (scope === 'current' && pid) {
      store.state.history = store.state.history.filter((h) => h.profileId !== pid || h.pinned)
    } else {
      store.state.history = store.state.history.filter((h) => h.pinned)
    }
    store.queueSave('history', true)
    renderRight()
  }

  /* ========== dialogs ========== */
  function confirmDialog(message, opts) {
    return new Promise((resolve) => {
      const root = $('confirm-root')
      const title = $('confirm-title')
      const body = $('confirm-body')
      const ok = $('confirm-ok')
      const cancel = $('confirm-cancel')
      title.textContent = (opts && opts.title) || '确认'
      body.textContent = message
      ok.textContent = (opts && opts.okText) || '确定'
      cancel.textContent = (opts && opts.cancelText) || '取消'
      ok.className = 'btn ' + ((opts && opts.danger) ? 'danger' : 'primary')
      const done = (v) => {
        root.classList.remove('show')
        ok.onclick = null
        cancel.onclick = null
        document.removeEventListener('keydown', onKey, true)
        resolve(v)
      }
      const onKey = (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault()
          ev.stopPropagation()
          done(false)
        }
      }
      ok.onclick = () => done(true)
      cancel.onclick = () => done(false)
      document.addEventListener('keydown', onKey, true)
      root.classList.add('show')
    })
  }

  function promptDialog(title, placeholder, initial) {
    return new Promise((resolve) => {
      const root = $('prompt-root')
      $('prompt-title').textContent = title
      const input = $('prompt-input')
      input.placeholder = placeholder || ''
      input.value = initial || ''
      const done = (v) => {
        root.classList.remove('show')
        $('prompt-ok').onclick = null
        $('prompt-cancel').onclick = null
        resolve(v)
      }
      $('prompt-ok').onclick = () => done(input.value)
      $('prompt-cancel').onclick = () => done(null)
      root.classList.add('show')
      setTimeout(() => input.focus(), 30)
    })
  }

  function downloadJson(filename, data) {
    try {
      const text = JSON.stringify(data, null, 2)
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      return true
    } catch (e) {
      toast('下载失败：' + err(e), 'error')
      return false
    }
  }

  /* ========== theme ========== */
  function onTheme() {
    for (const s of sessions.values()) {
      if (s.term) s.term.setTheme()
    }
    renderMetrics()
  }

  async function registerPluginSettings() {
    await api.settingsRegister({
      id: 'ssh.prefs',
      title: 'SSH',
      items: [
        {
          key: 'followShellTheme',
          type: 'switch',
          label: '跟随壳子主题',
          default: true,
        },
      ],
    })
    const follow = await api.settingsGet('followShellTheme', true)
    followShellTheme = follow !== false && follow !== 'false' && follow !== 0
    return followShellTheme
  }

  async function initPluginTheme() {
    const follow = await registerPluginSettings()
    await api.initTheme(onTheme, { followShellTheme: follow })
    try {
      api.raw?.onEnter?.(async () => {
        const next = await api.settingsGet('followShellTheme', true)
        const val = next !== false && next !== 'false' && next !== 0
        if (val !== followShellTheme) {
          followShellTheme = val
          await api.initTheme(onTheme, { followShellTheme: val })
          onTheme()
        }
      })
    } catch {
      /* optional */
    }
  }

  /* ========== sessions ========== */
  function ensureSession(profileId) {
    // 同一 profile 已有非 exited 会话时复用，避免重复 Tab
    for (const s of sessions.values()) {
      if (s.profileId === profileId && s.status !== 'exited') {
        setActiveTab(s.tabId)
        return s
      }
    }
    const id = store.uid('sess')
    const s = {
      tabId: id,
      profileId,
      sessionId: null,
      status: 'idle',
      error: '',
      buffer: '',
      metrics: [],
      metricsOn: false,
      metricsTimer: null,
      term: null,
      sftp: { path: '.', entries: [], error: '', selected: '' },
      lastCommand: '',
      commandStart: 0,
    }
    sessions.set(id, s)
    setActiveTab(id)
    return s
  }

  function activeSession() {
    return sessions.get(activeSessionId) || null
  }

  function setActiveTab(tabId) {
    activeSessionId = tabId
    store.setUi({ openProfileIds: Array.from(sessions.values()).map((s) => s.profileId) })
    renderSessionTabs()
    mountActiveTerminal()
    renderMetrics()
    renderSftp()
    renderHintMeta()
    renderTopStatus()
    updateFab()
  }

  function mountActiveTerminal() {
    const s = activeSession()
    const wrap = $('term-wrap')
    if (!wrap) return

    /** 不 dispose 已有 term：Tab 切换只卸载 DOM，会话内实例保留 */
    if (!s) {
      wrap.innerHTML = ''
      const emp = document.createElement('div')
      emp.className = 'term-empty'
      emp.id = 'term-empty'
      emp.innerHTML =
        '<div>未连接<div class="empty-act"><button class="btn sm primary" data-act="empty-new">新建连接</button></div></div>'
      emp.onclick = (ev) => {
        if (ev.target?.dataset?.act === 'empty-new') openProfileForm(null)
      }
      wrap.appendChild(emp)
      wrap.__term = null
      wrap.__termOwner = null
      return
    }

    const needRemount =
      wrap.__termOwner !== s.tabId || !s.term || !wrap.contains(s.term.el)

    if (needRemount) {
      wrap.innerHTML = ''
      const ban = document.createElement('div')
      ban.className = 'term-banner'
      ban.id = 'term-banner'
      const emp = document.createElement('div')
      emp.className = 'term-empty hidden'
      emp.id = 'term-empty'
      const host = document.createElement('div')
      host.className = 'term-host'
      host.id = 'term-host'
      wrap.appendChild(ban)
      wrap.appendChild(emp)
      wrap.appendChild(host)
      if (!s.term) {
        s.term = Term.createTerminal(host, {
          onData(data) {
            void sendInput(data)
          },
          onResize(cols, rows) {
            void resizePty(cols, rows)
          },
          onSelection(text) {
            if (text && store.state.ui.selectCopy) {
              api.copyText(text).then(
                () => {},
                () => {}
              )
            }
          },
        })
        if (s.buffer) s.term.write(s.buffer)
      } else {
        host.appendChild(s.term.el)
        s.term.fit && s.term.fit()
      }
      wrap.__term = s.term
      wrap.__termOwner = s.tabId
    }

    const b = $('term-banner')
    const e = $('term-empty')
    if (b) {
      if (s.error) {
        b.innerHTML =
          '<div>' +
          escapeHtml(s.error) +
          '</div><div class="banner-actions">' +
          '<button class="btn sm" data-act="reconnect">重连</button>' +
          '<button class="btn sm ghost" data-act="dismiss">×</button></div>'
        b.classList.add('show')
        b.onclick = (ev) => {
          const act = ev.target?.dataset?.act
          if (act === 'reconnect') void connectActive(true)
          if (act === 'dismiss') {
            s.error = ''
            b.classList.remove('show')
          }
        }
      } else {
        b.classList.remove('show')
        b.innerHTML = ''
      }
    }
    if (e) {
      if (s.status === 'connected' || s.status === 'connecting') {
        e.classList.add('hidden')
      } else if (!s.sessionId) {
        e.classList.remove('hidden')
        const p = store.findProfile(s.profileId)
        e.innerHTML =
          '<div>' +
          escapeHtml(p ? profileTitle(p) : s.profileId) +
          (statusLabel(s.status) ? ' · ' + statusLabel(s.status) : '') +
          '<div class="empty-act"><button class="btn sm primary" data-act="empty-connect">连接</button></div></div>'
        e.onclick = (ev) => {
          if (ev.target?.dataset?.act === 'empty-connect' && p) void connectProfile(p)
        }
      } else {
        e.classList.add('hidden')
      }
    }
  }

  async function sendInput(data) {
    const s = activeSession()
    if (!s || !s.sessionId) return
    // 终端内补全：Tab / 方向键 / Enter / Esc 先交给补全，不发给远端
    if (completionState.open && completionState.items.length) {
      if (data === '\t') {
        applyCompletion(completionState.index)
        return
      }
      if (data === '\x1b[A') {
        const n = Math.min(40, completionState.items.length)
        completionState.index = (completionState.index - 1 + n) % n
        renderCompletion()
        return
      }
      if (data === '\x1b[B') {
        completionState.index = (completionState.index + 1) % Math.min(40, completionState.items.length)
        renderCompletion()
        return
      }
      if (data === '\x1b') {
        completionState.open = false
        renderCompletion()
        return
      }
    }
    try {
      await api.sshWrite(s.sessionId, data)
      if (data === '\r' || data === '\n') {
        if (s.lastCommand && store.state.ui.recordHistory) {
          store.pushHistory({ profileId: s.profileId, command: s.lastCommand, ts: Date.now() })
          s.lastCommand = ''
          if ($('drawer')?.classList.contains('open')) renderRight()
        }
        completionState.open = false
        renderCompletion()
        renderHintMeta()
      } else if (data === '\x7f' || data === '\b') {
        s.lastCommand = s.lastCommand.slice(0, -1)
        scheduleCompletion()
        renderHintMeta()
      } else if (data.length === 1 && data >= ' ') {
        s.lastCommand += data
        if (s.lastCommand.length > 2000) s.lastCommand = s.lastCommand.slice(-2000)
        scheduleCompletion()
        renderHintMeta()
      }
    } catch (e) {
      toast(api.errMessage(e), 'error')
    }
  }

  function termFocus() {
    const s = activeSession()
    if (s?.term?.focus) s.term.focus()
  }

  async function resizePty(cols, rows) {
    const s = activeSession()
    if (!s || !s.sessionId) return
    try {
      await api.sshResize(s.sessionId, cols, rows)
    } catch {
      /* silent */
    }
  }

  /* ========== connect lifecycle ========== */
  function buildConnectPayload(profile, ephemeralPassword, jumpPassword) {
    const size = activeSession()?.term?.getSize?.() || { cols: 120, rows: 32 }
    const payload = {
      profileId: profile.id,
      host: profile.host,
      port: Number(profile.port) || 22,
      username: profile.username,
      authType: profile.authType || 'password',
      secretRef: profile.secretRef || undefined,
      privateKeyPath: profile.privateKeyPath || undefined,
      keepAliveSec: Number(profile.keepAliveSec) || 30,
      timeoutMs: Number(profile.timeoutMs) || 20000,
      term: profile.term || 'xterm-256color',
      cols: size.cols || Number(profile.cols) || 120,
      rows: size.rows || Number(profile.rows) || 32,
      fingerprintPolicy: profile.fingerprintPolicy || 'tofu',
    }
    // 只传 secretRef / ephemeral password；绝不把明文写入 profile
    if (ephemeralPassword) payload.password = ephemeralPassword
    if (profile.jump && profile.jump.host) {
      payload.jump = {
        host: profile.jump.host,
        port: Number(profile.jump.port) || 22,
        username: profile.jump.username || profile.username,
        authType: profile.jump.authType || (profile.jump.privateKeyPath ? 'key' : 'password'),
        privateKeyPath: profile.jump.privateKeyPath || undefined,
        secretRef: profile.jump.secretRef || undefined,
      }
      if (jumpPassword) payload.jump.ephemeralSecret = jumpPassword
    }
    return payload
  }

  async function connectProfile(profile, opts) {
    if (!profile || !profile.host) {
      toast('连接配置无效', 'error')
      return null
    }
    hostSshReady = api.hasHostSsh()
    const s = ensureSession(profile.id)
    if (s.sessionId && s.status === 'connected') {
      s.term && s.term.focus()
      return s
    }

    let ephemeralPassword
    const authType = profile.authType || 'password'
    if (authType === 'password' && !profile.secretRef) {
      if (opts && opts.ephemeralPassword != null) ephemeralPassword = opts.ephemeralPassword
      else {
        const pw = await promptDialog('密码', '仅本次使用，不保存', '')
        if (pw == null || pw === '') {
          toast('已取消', 'warn')
          return s
        }
        ephemeralPassword = pw
      }
    }

    // 跳板无已存密钥时，仅本次输入（不入库）
    let jumpPassword
    const jump = profile.jump
    const jumpAuth = jump?.authType || (jump?.privateKeyPath ? 'key' : 'password')
    if (
      jump &&
      jump.host &&
      jumpAuth === 'password' &&
      !jump.secretRef &&
      !(opts && opts.jumpPassword != null)
    ) {
      const jpw = await promptDialog('跳板主机密码', jump.username + '@' + jump.host + ' · 仅本次使用', '')
      if (jpw != null && jpw !== '') jumpPassword = jpw
    } else if (opts && opts.jumpPassword != null) {
      jumpPassword = opts.jumpPassword
    }

    s.status = 'connecting'
    s.error = ''
    renderSessionTabs()
    mountActiveTerminal()
    renderTopStatus()
    s.term && s.term.writeln('\r\n\x1b[33m…\x1b[0m ' + profile.username + '@' + profile.host + '\r\n')

    const payload = buildConnectPayload(profile, ephemeralPassword, jumpPassword)
    try {
      const res = await api.sshConnect(payload)
      const sessionId = res && (res.sessionId || res.id || res.sessionID)
      if (!sessionId) throw new Error('ssh.connect 未返回 sessionId')
      s.sessionId = sessionId
      s.status = 'connected'
      s.error = ''
      profile.lastConnectedAt = Date.now()
      store.upsertProfile({ ...profile })
      s.lastCommand = ''
      if (s.term) {
        const size = s.term.getSize()
        void api.sshResize(sessionId, size.cols, size.rows).catch(() => {})
        // 连接成功后焦点进终端，直接打字执行
        setTimeout(() => termFocus(), 50)
      }
      if (store.state.ui.monitorOn) void startMetrics(s)
      toast('已连接', 'success')
      renderLeft()
      renderHintMeta()
    } catch (e) {
      s.status = 'disconnected'
      s.error = api.friendlyConnectError(e)
      s.term && s.term.writeln('\x1b[31m[SSH]\x1b[0m ' + s.error + '\r\n')
      toast(s.error, 'error')
    }
    renderSessionTabs()
    mountActiveTerminal()
    renderTopStatus()
    updateFab()
    return s
  }

  async function connectActive(reconnect) {
    const s = activeSession()
    if (!s) return
    const profile = store.findProfile(s.profileId)
    if (!profile) {
      toast('连接配置不存在', 'error')
      return
    }
    if (reconnect) {
      if (s.sessionId) {
        try {
          await api.sshDisconnect(s.sessionId)
        } catch {
          /* ignore */
        }
      }
      s.sessionId = null
    }
    await connectProfile(profile)
  }

  async function disconnectSession(s, silent) {
    if (!s) return
    if (s.metricsOn) await stopMetrics(s)
    if (s.sessionId) {
      try {
        await api.sshDisconnect(s.sessionId)
      } catch (e) {
        if (!silent) {
          const msg = err(e)
          toast(msg.includes('not found') ? '会话已断开' : '断开失败：' + msg, 'warn')
        }
      }
    }
    s.sessionId = null
    s.status = 'disconnected'
    renderSessionTabs()
    mountActiveTerminal()
    renderTopStatus()
    updateFab()
  }

  async function closeTab(tabId) {
    const s = sessions.get(tabId)
    if (!s) return
    if (s.status === 'connected' || s.status === 'connecting') {
      const ok = await confirmDialog('断开并关闭？', {
        title: '关闭会话',
        okText: '关闭',
        danger: true,
      })
      if (!ok) return
      await disconnectSession(s, true)
    }
    // 关 Tab 必停监控（Spec SSH-F8）
    if (s.metricsOn) await stopMetrics(s)
    if (s.sessionId) {
      try {
        await api.sshDisconnect(s.sessionId)
      } catch {
        /* ignore */
      }
      s.sessionId = null
    }
    if (s.term) {
      try {
        s.term.dispose()
      } catch {
        /* ignore */
      }
    }
    sessions.delete(tabId)
    if (activeSessionId === tabId) {
      const next = sessions.keys().next()
      activeSessionId = next.done ? null : next.value
    }
    store.setUi({ openProfileIds: Array.from(sessions.values()).map((x) => x.profileId) })
    renderSessionTabs()
    mountActiveTerminal()
    renderMetrics()
    renderSftp()
    renderTopStatus()
    updateFab()
  }

  /* ========== host events ========== */
  function bindSshEvents() {
    api.on('ssh.data', (payload) => {
      const d = payload || {}
      const sid = d.sessionId || d.id
      const data = d.data != null ? d.data : d.chunk != null ? d.chunk : d.output
      if (!sid || data == null) return
      for (const s of sessions.values()) {
        if (s.sessionId === sid) {
          const text = typeof data === 'string' ? data : utf8(data)
          s.buffer += text
          if (s.buffer.length > 400000) s.buffer = s.buffer.slice(-400000)
          if (activeSessionId === s.tabId && s.term) s.term.write(text)
        }
      }
    })

    api.on('ssh.exit', (payload) => {
      const d = payload || {}
      const sid = d.sessionId || d.id
      for (const s of sessions.values()) {
        if (s.sessionId === sid || (!sid && s.sessionId && d.profileId === s.profileId)) {
          s.status = 'exited'
          const code = d.code != null ? d.code : d.exitCode
          s.error = '已退出' + (code != null ? ' (' + code + ')' : '')
          if (s.term) s.term.writeln('\r\n\x1b[31m[SSH]\x1b[0m ' + s.error + '\r\n')
          if (s.metricsOn) void stopMetrics(s)
          s.sessionId = null
        }
      }
      renderSessionTabs()
      mountActiveTerminal()
      renderTopStatus()
    })

    api.on('ssh.error', (payload) => {
      const d = payload || {}
      const sid = d.sessionId || d.id
      const message = d.message || d.error || 'SSH 错误'
      for (const s of sessions.values()) {
        if (!sid || s.sessionId === sid) {
          s.error = String(message)
          if (s.term) s.term.writeln('\r\n\x1b[31m[SSH]\x1b[0m ' + s.error + '\r\n')
        }
      }
      toast(message, 'error')
      mountActiveTerminal()
    })

    api.on('ssh.metrics', (payload) => {
      const d = payload || {}
      const sid = d.sessionId || d.id
      const metrics = d.metrics || d.sample || d.data || d
      for (const s of sessions.values()) {
        if (s.sessionId === sid) {
          s.metrics.push({ ts: d.ts || Date.now(), ...normalizeMetrics(metrics) })
          if (s.metrics.length > 120) s.metrics = s.metrics.slice(-120)
          if (activeSessionId === s.tabId) renderMetrics()
        }
      }
    })
  }

  function utf8(data) {
    if (typeof data === 'string') return data
    try {
      if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
      if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data)
      if (Array.isArray(data)) return new TextDecoder().decode(new Uint8Array(data))
    } catch {
      /* ignore */
    }
    return String(data)
  }

  function normalizeMetrics(m) {
    if (!m || typeof m !== 'object') return { cpu: 0, memPercent: 0 }
    const mem = m.mem || m.memory || {}
    return {
      cpu: Number(m.cpu ?? m.cpuPercent ?? 0),
      memUsed: Number(mem.used ?? m.memUsed ?? 0),
      memTotal: Number(mem.total ?? m.memTotal ?? 0),
      memPercent: Number(mem.percent ?? m.memPercent ?? 0),
      load1: Number(m.load1 ?? m.load ?? 0),
      disks: Array.isArray(m.disks)
        ? m.disks
        : Array.isArray(m.disk)
          ? m.disk.map((d) => ({
              mount: d.mount || d.filesystem || '',
              usedPercent: Number(d.usedPercent ?? d.usedPct ?? d.usePercent ?? 0),
              used: d.used,
              total: d.total,
            }))
          : [],
      net: Array.isArray(m.net)
        ? m.net
        : m.net && typeof m.net === 'object'
          ? m.net
          : {},
      uptime: m.uptime ?? m.uptimeSec,
      top: Array.isArray(m.top)
        ? m.top
        : Array.isArray(m.topProcesses)
          ? m.topProcesses.map((p) => ({
              pid: p.pid,
              user: p.user,
              cpu: Number(p.cpu ?? p.cpuPercent ?? 0),
              memPercent: Number(p.memPercent ?? p.mem ?? 0),
              cmd: p.cmd || p.command || '',
            }))
          : [],
      error: m.error || m.sampleError || null,
    }
  }

  /* ========== metrics ========== */
  async function startMetrics(s) {
    if (!s || !s.sessionId) {
      toast('请先连接', 'warn')
      return
    }
    try {
      await api.metricsStart(s.sessionId, Number(store.state.ui.monitorIntervalMs) || 5000)
      s.metricsOn = true
      store.setUi({ monitorOn: true })
    } catch (e) {
      s.metricsOn = false
      const msg = err(e)
      toast(
        msg.includes('功能未就绪') || !api.hasHostSsh()
          ? '功能未就绪'
          : '监控启动失败：' + msg,
        'error'
      )
    }
    renderMetrics()
  }

  async function stopMetrics(s) {
    if (!s) return
    try {
      if (s.sessionId) await api.metricsStop(s.sessionId)
    } catch {
      /* ignore */
    }
    s.metricsOn = false
    renderMetrics()
  }

  function levelClass(pct, warn, danger) {
    if (pct >= danger) return 'danger'
    if (pct >= warn) return 'warn'
    return ''
  }

  function drawSpark(canvas, values, color, warn, danger, last) {
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth || 200
    const h = canvas.clientHeight || 36
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    if (!values.length) return
    const max = Math.max(100, ...values)
    const min = 0
    const n = values.length
    ctx.beginPath()
    values.forEach((v, i) => {
      const x = n === 1 ? 0 : (i / (n - 1)) * w
      const y = h - ((v - min) / (max - min || 1)) * (h - 4) - 2
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    let stroke = color
    if (last >= danger) stroke = cssGet('--danger')
    else if (last >= warn) stroke = cssGet('--warn')
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.6
    ctx.stroke()
  }

  function cssGet(name, fb) {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb
    } catch {
      return fb
    }
  }

  function renderMetrics() {
    const body = $('metrics-body')
    const status = $('metrics-status')
    const toggle = $('metrics-toggle')
    const s = activeSession()
    if (!body) return
    if (!s) {
      body.innerHTML = '<div class="empty">无会话</div>'
      if (status) status.textContent = ''
      if (toggle) toggle.textContent = '开启'
      return
    }
    if (status) {
      status.textContent =
        statusLabel(s.status) +
        (s.metricsOn ? ' · 采集中' : '') +
        (s.metrics.length ? ' · ' + s.metrics.length : '')
    }
    if (toggle) toggle.textContent = s.metricsOn ? '停止' : '开启'

    const last = s.metrics[s.metrics.length - 1]
    if (!last) {
      body.innerHTML = '<div class="empty">' + (s.metricsOn ? '采样中…' : '未开启监控') + '</div>'
      return
    }
    if (last.error) {
      body.innerHTML = '<div class="empty">' + escapeHtml(last.error) + '</div>'
      return
    }

    const warn = Number(store.state.ui.warnThreshold) || 85
    const danger = Number(store.state.ui.dangerThreshold) || 95
    const cpus = s.metrics.map((m) => Number(m.cpu) || 0)
    const mems = s.metrics.map((m) => Number(m.memPercent) || 0)
    const cpuLvl = levelClass(last.cpu, warn, danger)
    const memLvl = levelClass(last.memPercent, warn, danger)

    let disksHtml = ''
    if (last.disks && last.disks.length) {
      disksHtml =
        '<div class="disk-row"><h3>磁盘</h3>' +
        last.disks
          .map((d) => {
            const pct = Number(d.usedPercent ?? d.percent ?? 0)
            const lvl = levelClass(pct, warn, danger)
            return (
              '<div class="disk-item"><div class="lbl"><span>' +
              escapeHtml(d.mount || d.name || '/') +
              '</span><span>' +
              pct.toFixed(1) +
              '%</span></div><div class="bar"><i class="' +
              lvl +
              '" style="width:' +
              Math.min(100, pct) +
              '%"></i></div></div>'
            )
          })
          .join('') +
        '</div>'
    }

    let procHtml = ''
    if (last.top && last.top.length) {
      procHtml =
        '<div class="proc-table"><h3>Top</h3><table><thead><tr>' +
        '<th>PID</th><th>USER</th><th>CPU%</th><th>MEM%</th><th>CMD</th>' +
        '</tr></thead><tbody>' +
        last.top
          .slice(0, 10)
          .map(
            (p) =>
              '<tr><td>' +
              escapeHtml(p.pid) +
              '</td><td>' +
              escapeHtml(p.user || p.username || '') +
              '</td><td>' +
              escapeHtml(p.cpu ?? '') +
              '</td><td>' +
              escapeHtml(p.mem ?? p.memPercent ?? '') +
              '</td><td>' +
              escapeHtml(p.command || p.cmd || '') +
              '</td></tr>'
          )
          .join('') +
        '</tbody></table></div>'
    }

    let netRx = '—'
    let netTx = '—'
    const netRaw = last.net
    if (Array.isArray(netRaw) && netRaw.length) {
      const rx = netRaw.reduce((a, n) => a + (Number(n.rxKbps ?? n.rx) || 0), 0)
      const tx = netRaw.reduce((a, n) => a + (Number(n.txKbps ?? n.tx) || 0), 0)
      netRx = fmtNum(rx)
      netTx = fmtNum(tx)
    } else if (netRaw && typeof netRaw === 'object') {
      netRx = fmtNum(netRaw.rxKbps ?? netRaw.rx)
      netTx = fmtNum(netRaw.txKbps ?? netRaw.tx)
    }

    body.innerHTML =
      '<div class="metric-grid">' +
      '<div class="metric-card"><h3>CPU</h3><div class="val ' +
      cpuLvl +
      '">' +
      (last.cpu != null ? Number(last.cpu).toFixed(1) : '—') +
      '%</div><canvas id="spark-cpu"></canvas></div>' +
      '<div class="metric-card"><h3>内存</h3><div class="val ' +
      memLvl +
      '">' +
      (last.memPercent != null ? Number(last.memPercent).toFixed(1) : '—') +
      '%</div><div style="color:var(--text-3);font-size:10px;margin-top:2px">' +
      fmtBytes(last.memUsed) +
      ' / ' +
      fmtBytes(last.memTotal) +
      '</div><canvas id="spark-mem"></canvas></div>' +
      '<div class="metric-card"><h3>Load</h3><div class="val">' +
      (last.load1 != null ? Number(last.load1).toFixed(2) : '—') +
      '</div></div>' +
      '<div class="metric-card"><h3>Net</h3><div class="val" style="font-size:13px">↓' +
      netRx +
      ' ↑' +
      netTx +
      '</div></div>' +
      '<div class="metric-card"><h3>Uptime</h3><div class="val" style="font-size:13px">' +
      escapeHtml(String(last.uptime ?? '—')) +
      '</div></div>' +
      '</div>' +
      disksHtml +
      procHtml

    const accent = cssGet('--accent', '#5b8cff')
    drawSpark($('spark-cpu'), cpus, accent, warn, danger, last.cpu)
    drawSpark($('spark-mem'), mems, accent, warn, danger, last.memPercent)
  }

  function fmtNum(v) {
    if (v == null || v === '') return '—'
    return String(v)
  }

  function fmtBytes(n) {
    if (n == null || n === 0) return '—'
    const num = Number(n)
    if (!isFinite(num)) return String(n)
    if (num > 1024 * 1024 * 1024) return (num / 1024 / 1024 / 1024).toFixed(1) + 'G'
    if (num > 1024 * 1024) return (num / 1024 / 1024).toFixed(1) + 'M'
    if (num > 1024) return (num / 1024).toFixed(1) + 'K'
    return String(num)
  }

  /* ========== sftp ========== */
  async function sftpRefresh() {
    const s = activeSession()
    if (!s || !s.sessionId) {
      toast('请先连接', 'warn')
      return
    }
    const path = ($('sftp-path')?.value || s.sftp.path || '.').trim() || '.'
    try {
      const res = await api.sftpList(s.sessionId, path)
      // 宿主直接返回 SftpEntry[]；也兼容 { entries|files|list, path }
      let entries
      let resolvedPath = path
      if (Array.isArray(res)) {
        entries = res
      } else {
        entries = (res && (res.entries || res.files || res.list)) || []
        if (res && typeof res.path === 'string' && res.path) resolvedPath = res.path
      }
      s.sftp = {
        path: resolvedPath,
        entries: Array.isArray(entries) ? entries : [],
        error: '',
        selected: s.sftp.selected || '',
      }
    } catch (e) {
      const msg = err(e)
      s.sftp = { ...s.sftp, error: api.hasHostSsh() ? msg : '功能未就绪' }
      toast(s.sftp.error, 'error')
    }
    renderSftp()
  }

  async function sftpDownload() {
    const s = activeSession()
    if (!s || !s.sessionId) {
      toast('请先连接', 'warn')
      return
    }
    const name = s.sftp.selected
    if (!name) {
      toast('请先选择文件', 'warn')
      return
    }
    const remote = joinPath(s.sftp.path || '.', name)
    // 宿主选目录 → 拼文件名；取消选择 → 不传 localPath，宿主默认 ~/Downloads/<name>
    let localPath
    const picked = await api.pickLocalFile({ mode: 'dir' })
    if (picked && picked.path) localPath = joinPath(picked.path, name)
    try {
      const res = await api.sftpDownload(s.sessionId, remote, localPath)
      if (res && res.ok === false) throw new Error(res.error || res.message || '下载失败')
      const out = res && (res.localPath || res.path) ? ' → ' + (res.localPath || res.path) : ''
      toast('已下载 ' + name + out, 'success')
    } catch (e) {
      toast(err(e), 'error')
    }
  }

  async function sftpUpload() {
    const s = activeSession()
    if (!s || !s.sessionId) {
      toast('请先连接', 'warn')
      return
    }
    let localPath
    const picked = await api.pickLocalFile({ mode: 'file' })
    if (picked && picked.path) localPath = picked.path
    else {
      localPath = await promptDialog('本地文件路径', '', '')
      if (localPath == null || !String(localPath).trim()) return
      localPath = String(localPath).trim()
    }
    const base = String(localPath).split(/[\\/]/).filter(Boolean).pop() || 'upload.bin'
    const remoteDir = s.sftp.path || '.'
    // 宿主 createWriteStream 需要完整远程文件路径，不能只传目录
    const remotePath = joinPath(remoteDir, base)
    try {
      const res = await api.sftpUpload(s.sessionId, localPath, remotePath)
      if (res && res.ok === false) throw new Error(res.error || res.message || '上传失败')
      toast('已上传 ' + base, 'success')
      await sftpRefresh()
    } catch (e) {
      toast(err(e), 'error')
    }
  }

  function joinPath(dir, name) {
    if (!dir || dir === '.') return name
    if (dir.endsWith('/')) return dir + name
    return dir + '/' + name
  }

  function fmtMtime(m) {
    if (m == null || m === '' || m === 0) return ''
    if (typeof m === 'number' && isFinite(m)) {
      const ts = m > 1e12 ? m : m * 1000
      try {
        return new Date(ts).toLocaleString()
      } catch {
        return String(m)
      }
    }
    return String(m)
  }

  function renderSftp() {
    const body = $('sftp-list')
    const pathInput = $('sftp-path')
    const meta = $('sftp-meta')
    const s = activeSession()
    if (!body) return
    if (!s) {
      body.innerHTML = '<div class="empty">无会话</div>'
      return
    }
    if (pathInput && document.activeElement !== pathInput) pathInput.value = s.sftp.path || '.'
    if (meta) {
      meta.textContent =
        s.sftp.error ||
        (s.sftp.entries && s.sftp.entries.length
          ? s.sftp.entries.length + ' 项' + (s.sftp.selected ? ' · 已选 ' + s.sftp.selected : '')
          : '')
    }
    const entries = s.sftp.entries || []
    if (!entries.length) {
      body.innerHTML =
        '<div class="empty">' +
        (s.sftp.error ? escapeHtml(s.sftp.error) : s.sessionId ? '空目录' : '未连接') +
        '</div>'
      return
    }
    body.innerHTML =
      '<table><thead><tr><th>名称</th><th>大小</th><th>时间</th></tr></thead><tbody>' +
      entries
        .map((e, idx) => {
          const isDir = e.isDir || e.isDirectory || e.type === 'dir' || e.type === 'd'
          const selected = s.sftp.selected === e.name
          return (
            '<tr data-idx="' +
            idx +
            '"' +
            (selected ? ' class="selected"' : '') +
            '><td class="name ' +
            (isDir ? 'dir' : '') +
            '">' +
            escapeHtml(e.name) +
            '</td><td>' +
            (isDir ? '—' : fmtBytes(e.size)) +
            '</td><td>' +
            escapeHtml(fmtMtime(e.mtime ?? e.modifiedAt)) +
            '</td></tr>'
          )
        })
        .join('') +
      '</tbody></table>'
    body.onclick = (ev) => {
      const tr = ev.target.closest('tr[data-idx]')
      if (!tr) return
      const e = entries[Number(tr.dataset.idx)]
      if (!e) return
      const isDir = e.isDir || e.isDirectory || e.type === 'dir' || e.type === 'd'
      s.sftp.selected = e.name
      if (isDir) {
        s.sftp.path = joinPath(s.sftp.path || '.', e.name)
        s.sftp.selected = ''
        void sftpRefresh()
      } else {
        renderSftp()
      }
    }
  }

  /* ========== completion（跟随终端输入，不单独命令框） ========== */
  function terminalCommand() {
    const s = activeSession()
    return (s && s.lastCommand) || ''
  }

  function activeHintInput() {
    return $('hint-input')
  }

  function scheduleCompletion() {
    clearTimeout(completionTimer)
    completionTimer = setTimeout(() => void runCompletion(), 80)
  }

  async function runCompletion(force) {
    const prefix = terminalCommand()
    if (!prefix && !force) {
      completionState = { items: [], index: 0, open: false }
      renderCompletion()
      return
    }
    const s = activeSession()
    const sources = {
      prefix,
      profileId: s?.profileId,
      history: store.state.history,
      snippets: store.state.snippets,
      userDict: [],
    }

    let items = dict.localSuggest(prefix, sources)

    if (s && s.sessionId) {
      const cacheKey = s.sessionId + '|' + prefix
      const cached = pathCache.get(cacheKey)
      if (!force && cached && Date.now() - cached.ts < 3000) {
        items = mergeItems(items, cached.items)
      } else {
        try {
          const profileHist = store.state.history
            .filter((h) => h.command && (!h.profileId || !s.profileId || h.profileId === s.profileId))
            .slice(0, 40)
            .map((h) => h.command)
          const globalHist = store.state.history.slice(0, 40).map((h) => h.command).filter(Boolean)
          const res = await api.completionSuggest(s.sessionId, prefix, {
            line: prefix,
            cursor: prefix.length,
            history: Array.from(new Set(profileHist.concat(globalHist))).slice(0, 50),
            snippets: (store.state.snippets || []).map((sn) => ({
              title: sn.title || '',
              command: sn.command || '',
            })),
          })
          const mapped = api.mapHostCompletionItems(res)
          pathCache.set(cacheKey, { ts: Date.now(), items: mapped })
          items = mergeItems(items, mapped)
        } catch {
          /* silent local fallback */
        }
      }
    }

    completionState = { items, index: 0, open: items.length > 0 }
    renderCompletion()
    renderHintMeta()
  }

  function mergeItems(base, extra) {
    const seen = new Set(base.map((i) => i.kind + '|' + i.text))
    const out = base.slice()
    for (const it of extra || []) {
      const k = it.kind + '|' + it.text
      if (seen.has(k)) continue
      seen.add(k)
      out.unshift(it)
    }
    return out
  }

  function itemDanger(it, env) {
    if (it.dangerous) {
      return {
        id: 'host',
        level: 'danger',
        reason: it.dangerDetail || '危险命令',
      }
    }
    return dict.matchDanger(it.text, env)
  }

  function renderCompletion() {
    const box = $('completion-list')
    if (!box) return
    if (!completionState.open || !completionState.items.length) {
      box.classList.remove('show')
      box.innerHTML = ''
      renderHintMeta()
      return
    }
    const profile = activeSession() ? store.findProfile(activeSession().profileId) : null
    const env = profile?.env
    box.innerHTML = completionState.items
      .slice(0, 40)
      .map((it, i) => {
        const danger = itemDanger(it, env)
        return (
          '<div class="completion-item ' +
          (i === completionState.index ? 'selected ' : '') +
          (danger ? 'danger-item' : '') +
          '" data-i="' +
          i +
          '"><span class="kind ' +
          escapeHtml(it.kind) +
          '">' +
          escapeHtml(it.kind) +
          '</span><span class="label">' +
          escapeHtml(it.text) +
          (danger ? ' 危险' : '') +
          '</span><span class="detail">' +
          escapeHtml(it.detail || (danger ? danger.reason : it.ts ? fmtRelTime(it.ts) : '')) +
          '</span></div>'
        )
      })
      .join('')
    box.classList.add('show')
    box.onclick = (ev) => {
      const el = ev.target.closest('.completion-item')
      if (!el) return
      applyCompletion(Number(el.dataset.i))
    }
    renderHintMeta()
  }

  function applyCompletion(index) {
    const item = completionState.items[index]
    const s = activeSession()
    if (!item || !s) return
    const prefix = terminalCommand()
    let next = item.text
    const parts = prefix.split(/\s+/)
    if (item.kind === 'flag' && item.replace === 'last' && parts.length) {
      parts[parts.length - 1] = String(item.text).split(/\s+/).pop()
      next = parts.join(' ')
    } else if (item.kind === 'path' && parts.length) {
      parts[parts.length - 1] = item.text
      next = parts.join(' ')
    }
    completionState.open = false
    renderCompletion()
    void (async () => {
      if (next.startsWith(prefix)) {
        await sendInput(next.slice(prefix.length))
      } else if (prefix) {
        await sendInput('\x7f'.repeat(prefix.length))
        await sendInput(next)
      } else {
        await sendInput(next)
      }
      termFocus()
      renderHintMeta()
    })()
  }

  function renderHintMeta() {
    const meta = $('hint-meta')
    if (!meta) return
    const cmd = terminalCommand()
    const s = activeSession()
    const profile = s ? store.findProfile(s.profileId) : null
    const danger = dict.matchDanger(cmd, profile?.env)
    const bits = []
    if (danger) bits.push('<span class="badge danger">' + escapeHtml(danger.reason) + '</span>')
    if (!hostSshReady && api.raw) bits.push('<span>功能未就绪</span>')
    if (s && s.status !== 'connected' && cmd.trim()) bits.push('<span>未连接</span>')
    if (s && s.status === 'connected') bits.push('<span>直接在终端输入，回车执行</span>')
    meta.innerHTML = bits.join(' ')
  }

  async function submitHint(cmdOverride) {
    const s = activeSession()
    if (!s || !s.sessionId) {
      toast('请先连接', 'warn')
      return
    }
    if (!api.hasHostSsh()) {
      toast('功能未就绪', 'error')
      return
    }
    const cmd = String(cmdOverride ?? terminalCommand()).trim()
    if (!cmd) {
      termFocus()
      return
    }
    const profile = store.findProfile(s.profileId)
    const danger = dict.matchDanger(cmd, profile?.env)
    if (danger) {
      const exempt = store.state.ui.dangerExempt || {}
      const key = (s.profileId || '') + ':' + danger.id
      if (!exempt[key]) {
        const ok = await confirmDialog(danger.reason + '\n\n' + cmd, {
          title: '危险命令',
          okText: '仍要执行',
          danger: true,
        })
        if (!ok) return
        exempt[key] = Date.now()
        store.setUi({ dangerExempt: exempt })
      }
    }
    // 回车执行：远端 shell 自己回显
    if (cmdOverride != null && cmdOverride !== terminalCommand()) {
      // 从历史「执行」：清空当前输入再整条写入
      const cur = terminalCommand()
      if (cur) await sendInput('\x7f'.repeat(cur.length))
      await sendInput(cmd)
    }
    await sendInput('\r')
    store.pushHistory({ profileId: s.profileId, command: cmd, ts: Date.now() })
    s.lastCommand = ''
    completionState.open = false
    renderCompletion()
    renderHintMeta()
    if ($('drawer')?.classList.contains('open')) renderRight()
    termFocus()
  }

  /* ========== left tree ========== */
  function renderLeft() {
    const tree = $('tree')
    if (!tree) return
    const ui = store.state.ui
    const tags = store.allTags()

    const filterRow = $('filter-row')
    if (filterRow) {
      const showFilters =
        document.activeElement === $('search-input') ||
        !!(ui.filterEnv || ui.filterTag || ui.filterFavorite || ui.filterRecent || (ui.search || '').trim())
      if (!showFilters) {
        filterRow.innerHTML = ''
      } else {
        const envs = ['', 'prod', 'staging', 'dev']
        filterRow.innerHTML =
          envs
            .map(
              (e) =>
                '<button class="chip ' +
                (ui.filterEnv === e ? 'active' : '') +
                '" data-filter="env" data-value="' +
                e +
                '">' +
                (e || '全部') +
                '</button>'
            )
            .join('') +
          '<button class="chip ' +
          (ui.filterFavorite ? 'active' : '') +
          '" data-filter="fav">★</button>' +
          '<button class="chip ' +
          (ui.filterRecent ? 'active' : '') +
          '" data-filter="recent">最近</button>' +
          tags
            .slice(0, 6)
            .map(
              (t) =>
                '<button class="chip ' +
                (ui.filterTag === t ? 'active' : '') +
                '" data-filter="tag" data-value="' +
                escapeHtml(t) +
                '">#' +
                escapeHtml(t) +
                '</button>'
            )
            .join('')
      }
      filterRow.onclick = (ev) => {
        const btn = ev.target.closest('.chip')
        if (!btn) return
        const kind = btn.dataset.filter
        if (kind === 'env') store.setUi({ filterEnv: btn.dataset.value || '' })
        else if (kind === 'fav') store.setUi({ filterFavorite: !ui.filterFavorite })
        else if (kind === 'recent') store.setUi({ filterRecent: !ui.filterRecent })
        else if (kind === 'tag')
          store.setUi({ filterTag: ui.filterTag === btn.dataset.value ? '' : btn.dataset.value })
        renderLeft()
      }
    }

    const searchInput = $('search-input')
    if (searchInput && document.activeElement !== searchInput) searchInput.value = ui.search || ''

    renderSelBar()

    if (!store.state.profiles.length) {
      tree.innerHTML =
        '<div class="empty">暂无连接<div class="empty-act"><button class="btn sm primary" data-act="empty-new-profile">新建连接</button></div></div>'
    } else {
      const visible = store.state.profiles.filter(store.matchesFilters)
      const ungrouped = visible.filter((p) => !(p.groupId && store.findGroup(p.groupId)))
      const html = []
      html.push(renderGroupNode('', '未分组', ungrouped, 0, null))
      const roots = store.childrenOf('')
      for (const g of roots) html.push(renderGroupNode(g.id, g.name, null, 0, g))
      tree.innerHTML = html.join('') || '<div class="empty">无匹配</div>'
    }

    tree.onclick = onTreeClick

    bindCtx(tree, (ev) => {
      const profileEl = ev.target.closest('[data-profile]')
      if (profileEl) return profileMenuItems(profileEl.dataset.profile)
      const groupEl = ev.target.closest('[data-group]')
      if (groupEl) return groupMenuItems(groupEl.dataset.group)
      return groupMenuItems('')
    })
  }

  function renderGroupNode(id, name, directProfiles, depth, group) {
    const ui = store.state.ui
    const collapsed = !!(ui.collapsedGroups || {})[id || '_root']
    const selected = ui.selectedGroupId === id
    const color = group?.color || ''
    const childGroups = group ? store.childrenOf(group.id) : store.childrenOf('')
    const searching = !!(
      (ui.search || '').trim() ||
      ui.filterTag ||
      ui.filterEnv ||
      ui.filterFavorite ||
      ui.filterRecent
    )
    const isOpen = searching || !collapsed
    const profiles =
      directProfiles ||
      store.profilesInGroup(id).filter((p) => store.matchesFilters(p))
    const childCount = group
      ? childGroups.length + store.profilesInGroup(id).filter(store.matchesFilters).length
      : profiles.length

    let html =
      '<div class="group-block" data-group="' +
      escapeHtml(id) +
      '"><div class="group-row ' +
      (selected ? 'selected' : '') +
      '" data-act="select-group" data-id="' +
      escapeHtml(id) +
      '" style="padding-left:' +
      (6 + depth * 10) +
      'px"><span class="twisty" data-act="toggle-group" data-id="' +
      escapeHtml(id) +
      '">' +
      (childCount ? (isOpen ? '▾' : '▸') : '·') +
      '</span><span class="group-dot" style="' +
      (color ? 'background:' + escapeHtml(color) : '') +
      '"></span><span class="g-name">' +
      escapeHtml(name) +
      '</span>' +
      (childCount ? '<span class="g-count">' + childCount + '</span>' : '') +
      '</div>'

    if (isOpen) {
      const list = (directProfiles || store.profilesInGroup(id)).filter(store.matchesFilters)
      for (const p of list.slice().sort(store.sortProfiles)) {
        html += profileCardHtml(p, depth + 1)
      }
      if (group) {
        for (const cg of childGroups) {
          html += renderGroupNode(cg.id, cg.name, null, depth + 1, cg)
        }
      }
    }
    html += '</div>'
    return html
  }

  function profileCardHtml(p, depth) {
    const s = Array.from(sessions.values()).find((x) => x.profileId === p.id)
    const selected = store.state.ui.selectedProfileId === p.id
    return (
      '<div class="profile-card ' +
      (selected ? 'selected' : '') +
      '" data-profile="' +
      escapeHtml(p.id) +
      '" style="margin-left:' +
      (6 + depth * 6) +
      'px"><div class="row1">' +
      (p.favorite ? '<span class="fav">★</span>' : '') +
      '<span class="name">' +
      escapeHtml(profileTitle(p)) +
      '</span>' +
      (s && s.status === 'connected' ? '<span class="badge ok">在线</span>' : '') +
      '</div><div class="host">' +
      escapeHtml((p.username || '') + '@' + (p.host || '') + (p.port && p.port !== 22 ? ':' + p.port : '')) +
      '</div><div class="meta">' +
      (p.env ? '<span class="' + envClass(p.env) + '">' + escapeHtml(p.env) + '</span>' : '') +
      (p.tags || [])
        .slice(0, 3)
        .map((t) => '<span class="badge">#' + escapeHtml(t) + '</span>')
        .join('') +
      '</div></div>'
    )
  }

  async function onTreeClick(ev) {
    const t = ev.target
    const actEl = t.closest('[data-act]')
    const card = t.closest('[data-profile]')
    const act = actEl?.dataset?.act
    const id = actEl?.dataset?.id

    if (t.dataset?.act === 'empty-new-profile' || t.dataset?.act === 'empty-new') {
      openProfileForm(null)
      return
    }

    if (act === 'toggle-group') {
      ev.stopPropagation()
      const collapsed = { ...(store.state.ui.collapsedGroups || {}) }
      const key = id || '_root'
      collapsed[key] = !collapsed[key]
      store.setUi({ collapsedGroups: collapsed })
      renderLeft()
      return
    }
    if (act === 'select-group') {
      store.setUi({ selectedGroupId: id || '', selectedProfileId: '' })
      renderLeft()
      renderTopStatus()
      updateFab()
      return
    }

    if (card) {
      store.setUi({ selectedProfileId: card.dataset.profile })
      renderLeft()
      renderTopStatus()
      updateFab()
    }
  }

  /* ========== profile form ========== */
  let formMode = null
  let formProfileId = null

  function openProfileForm(profile) {
    formMode = profile ? 'edit' : 'create'
    formProfileId = profile ? profile.id : null
    const p = profile || {
      id: '',
      name: '',
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      privateKeyPath: '',
      secretRef: '',
      jump: {},
      keepAliveSec: 30,
      timeoutMs: 20000,
      term: 'xterm-256color',
      cols: 120,
      rows: 32,
      env: 'dev',
      tags: [],
      color: '',
      groupId: store.state.ui.selectedGroupId || '',
      note: '',
      favorite: false,
      fingerprintPolicy: 'tofu',
    }

    $('form-title').textContent = profile ? '编辑连接' : '新建连接'
    $('f-name').value = p.name || ''
    $('f-host').value = p.host || ''
    $('f-port').value = p.port || 22
    $('f-username').value = p.username || ''
    $('f-auth').value = p.authType || 'password'
    $('f-keypath').value = p.privateKeyPath || ''
    $('f-password').value = ''
    $('f-passphrase').value = ''
    $('f-env').value = p.env || 'dev'
    $('f-tags').value = (p.tags || []).join(', ')
    $('f-color').value = p.color || ''
    $('f-group').value = p.groupId || ''
    $('f-note').value = p.note || ''
    $('f-fav').checked = !!p.favorite
    $('f-keepalive').value = p.keepAliveSec || 30
    $('f-timeout').value = p.timeoutMs || 20000
    $('f-term').value = p.term || 'xterm-256color'
    $('f-cols').value = p.cols || 120
    $('f-rows').value = p.rows || 32
    $('f-fp').value = p.fingerprintPolicy || 'tofu'
    $('f-jump-host').value = p.jump?.host || ''
    $('f-jump-port').value = p.jump?.port || 22
    $('f-jump-user').value = p.jump?.username || ''
    $('f-form-error').classList.remove('show')
    $('form-test-status').textContent = ''
    const adv = $('adv-block')
    if (adv) adv.open = false

    updateSecretState(p)
    updateAuthFields()
    renderGroupSelect()
    $('form-root').classList.add('show')
  }

  function updateSecretState(p) {
    const el = $('secret-state')
    const hasRef = !!(p && p.secretRef)
    el.innerHTML =
      (hasRef ? '<span class="badge ok">密码已保存</span>' : '<span class="badge">未保存密码</span>') +
      (hasRef
        ? ' <button type="button" class="btn sm danger" id="btn-clear-secret">清除</button>'
        : '')
    const clearBtn = $('btn-clear-secret')
    if (clearBtn) {
      clearBtn.onclick = async () => {
        const prof = formProfileId ? store.findProfile(formProfileId) : null
        if (prof?.secretRef) {
          try {
            await api.vaultRemove(prof.secretRef)
          } catch {
            /* ignore */
          }
          store.upsertProfile({ ...prof, secretRef: undefined })
          updateSecretState(store.findProfile(formProfileId))
        }
      }
    }
  }

  function updateAuthFields() {
    const auth = $('f-auth').value
    $('f-keypath-wrap').style.display = auth === 'key' ? '' : 'none'
    $('f-password-wrap').style.display = auth === 'password' ? '' : 'none'
    $('f-passphrase-wrap').style.display = auth === 'key' ? '' : 'none'
  }

  function renderGroupSelect() {
    const sel = $('f-group')
    const flat = []
    const walk = (parentId, depth) => {
      for (const g of store.childrenOf(parentId)) {
        flat.push({ id: g.id, name: '　'.repeat(depth) + g.name })
        walk(g.id, depth + 1)
      }
    }
    walk('', 0)
    sel.innerHTML =
      '<option value="">未分组</option>' +
      flat.map((g) => '<option value="' + escapeHtml(g.id) + '">' + escapeHtml(g.name) + '</option>').join('')
  }

  async function saveProfileForm() {
    const errEl = $('f-form-error')
    const name = $('f-name').value.trim()
    const host = $('f-host').value.trim()
    const username = $('f-username').value.trim()
    const env = $('f-env').value
    if (!name || !host || !username) {
      errEl.textContent = '名称 / 主机 / 用户名必填'
      errEl.classList.add('show')
      return
    }
    if (env === 'prod') {
      const dup = store.state.profiles.find(
        (p) => p.id !== formProfileId && p.env === 'prod' && p.name === name
      )
      if (dup) {
        const cont = await confirmDialog('生产环境已有同名连接，仍要保存？', {
          title: '名称冲突',
          okText: '仍要保存',
        })
        if (!cont) return
      }
    }

    const existing = formProfileId ? store.findProfile(formProfileId) : null
    const id = formProfileId || store.uid('prof')
    const authType = $('f-auth').value
    const tags = $('f-tags')
      .value.split(/[,，\s]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean)

    const profile = {
      ...(existing || {}),
      id,
      name,
      host,
      port: Number($('f-port').value) || 22,
      username,
      authType,
      privateKeyPath: $('f-keypath').value.trim() || undefined,
      secretRef: existing?.secretRef || undefined,
      keepAliveSec: Number($('f-keepalive').value) || 30,
      timeoutMs: Number($('f-timeout').value) || 20000,
      term: $('f-term').value.trim() || 'xterm-256color',
      cols: Number($('f-cols').value) || 120,
      rows: Number($('f-rows').value) || 32,
      env,
      tags,
      color: $('f-color').value || undefined,
      groupId: $('f-group').value || '',
      note: $('f-note').value.trim() || '',
      favorite: $('f-fav').checked,
      fingerprintPolicy: $('f-fp').value || 'tofu',
      lastConnectedAt: existing?.lastConnectedAt,
    }
    const jh = $('f-jump-host').value.trim()
    if (jh) {
      profile.jump = {
        host: jh,
        port: Number($('f-jump-port').value) || 22,
        username: $('f-jump-user').value.trim() || username,
        secretRef: existing?.jump?.secretRef,
      }
    } else {
      profile.jump = undefined
    }

    try {
      if (authType === 'password') {
        const pw = $('f-password').value
        if (pw) {
          if (!api.hasVault()) {
            errEl.textContent = '功能未就绪，无法保存密码'
            errEl.classList.add('show')
            return
          }
          const { secretRef } = await api.vaultSet('profile:' + id + ':auth', pw)
          if (!secretRef) throw new Error('密码保存失败')
          // 只存 secretRef，不落明文
          profile.secretRef = secretRef
        }
      } else if (authType === 'key') {
        const pp = $('f-passphrase').value
        if (pp) {
          if (!api.hasVault()) {
            errEl.textContent = '功能未就绪，无法保存密钥口令'
            errEl.classList.add('show')
            return
          }
          const { secretRef } = await api.vaultSet('profile:' + id + ':auth', pp)
          if (!secretRef) throw new Error('密钥口令保存失败')
          profile.secretRef = secretRef
        }
      }
    } catch (e) {
      const msg = err(e)
      if (isPerm(e)) errEl.textContent = '功能未就绪：无保存密码权限'
      else if (msg.includes('功能未就绪')) errEl.textContent = msg
      else errEl.textContent = '密码保存失败：' + msg
      errEl.classList.add('show')
      return
    }

    delete profile.password
    delete profile.passphrase

    store.upsertProfile(profile)
    $('form-root').classList.remove('show')
    store.setUi({ selectedProfileId: id })
    renderLeft()
    renderTopStatus()
    updateFab()
    toast(formMode === 'edit' ? '已保存' : '已创建', 'success')
  }

  /* ========== drawer body ========== */
  function renderRight() {
    const body = $('right-body')
    if (!body) return
    const tab = store.state.ui.rightTab || 'history'
    document.querySelectorAll('.drawer-tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab)
    })
    const scopeEl = $('right-scope')
    if (scopeEl) scopeEl.style.display = tab === 'history' ? '' : 'none'

    if (tab === 'snippets') {
      const q = ($('right-search')?.value || '').trim().toLowerCase()
      const list = store.state.snippets
        .filter(
          (s) =>
            !q ||
            ((s.title || '') + ' ' + (s.command || '') + ' ' + (s.tags || []).join(''))
              .toLowerCase()
              .includes(q)
        )
        .sort(
          (a, b) =>
            (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.sort || 0) - (b.sort || 0)
        )
      body.innerHTML =
        list
          .map(
            (s) =>
              '<div class="snip-item" data-snip="' +
              escapeHtml(s.id) +
              '" title="右键操作"><div class="cmd">' +
              escapeHtml(s.command) +
              '</div><div class="meta"><span>' +
              escapeHtml(s.title || '') +
              '</span>' +
              (s.tags || []).map((t) => '<span>#' + escapeHtml(t) + '</span>').join('') +
              '</div></div>'
          )
          .join('') || '<div class="empty">暂无常用</div>'
    } else {
      const scope = store.state.ui.historyScope || 'current'
      const q = ($('right-search')?.value || store.state.ui.historyQuery || '').trim()
      let list = store.state.history
      const pid = activeSession()?.profileId
      if (scope === 'current' && pid) list = list.filter((h) => h.profileId === pid)
      if (q) {
        const lower = q.toLowerCase()
        list = list.filter((h) => (h.command || '').toLowerCase().includes(lower))
      }
      body.innerHTML =
        list
          .slice(0, 200)
          .map(
            (h) =>
              '<div class="hist-item" data-hist="' +
              escapeHtml(h.id) +
              '" title="右键操作"><div class="cmd">' +
              escapeHtml(h.command || '') +
              '</div><div class="meta"><span>' +
              fmtRelTime(h.ts) +
              '</span></div></div>'
          )
          .join('') || '<div class="empty">暂无历史</div>'
    }
  }

  async function fillHint(cmd) {
    store.setUi({ centerTab: 'term' })
    renderCenterTabs()
    const s = activeSession()
    if (!s || !s.sessionId) {
      toast('请先连接后再填入终端', 'warn')
      return
    }
    const cur = s.lastCommand || ''
    if (cur) await sendInput('\x7f'.repeat(cur.length))
    await sendInput(String(cmd || ''))
    termFocus()
    scheduleCompletion()
    renderHintMeta()
  }

  async function runHint(cmd) {
    await submitHint(cmd)
  }

  /* ========== center views ========== */
  function renderCenterTabs() {
    const tab = store.state.ui.centerTab || 'term'
    const chip = $('view-chip')
    const label = $('view-chip-label')
    $('panel-term').classList.toggle('active', tab === 'term')
    $('panel-metrics').classList.toggle('active', tab === 'metrics')
    $('panel-sftp').classList.toggle('active', tab === 'sftp')
    if (chip) {
      if (tab === 'term') {
        chip.hidden = true
      } else {
        chip.hidden = false
        if (label) label.textContent = tab === 'metrics' ? '监控' : 'SFTP'
      }
    }
    if (tab === 'term') {
      const s = activeSession()
      if (s?.term) s.term.fit && s.term.fit()
    }
    if (tab === 'metrics') renderMetrics()
    if (tab === 'sftp') renderSftp()
    store.setUi({ centerTab: tab })
  }

  function renderSessionTabs() {
    const el = $('session-tabs')
    if (!el) return
    let html = ''
    for (const s of sessions.values()) {
      const p = store.findProfile(s.profileId)
      const title = p ? profileTitle(p) : s.profileId
      html +=
        '<div class="session-tab ' +
        (s.tabId === activeSessionId ? 'active' : '') +
        '" data-tab="' +
        escapeHtml(s.tabId) +
        '"><span class="status-dot ' +
        escapeHtml(s.status) +
        '"></span><span class="title">' +
        escapeHtml(title) +
        '</span><button class="close-x" data-close="' +
        escapeHtml(s.tabId) +
        '" title="关闭">×</button></div>'
    }
    el.innerHTML = html
    el.onclick = (ev) => {
      const close = ev.target.closest('[data-close]')
      if (close) {
        void closeTab(close.dataset.close)
        return
      }
      const tab = ev.target.closest('[data-tab]')
      if (tab) {
        setActiveTab(tab.dataset.tab)
        store.setUi({ centerTab: 'term' })
        renderCenterTabs()
      }
    }
  }

  /* ========== import / export ========== */
  async function exportAssets(stripSecrets) {
    const profiles = store.state.profiles.map((p) => {
      const copy = store.clone(p)
      if (stripSecrets !== false) {
        delete copy.secretRef
        if (copy.jump) copy.jump = { ...copy.jump, secretRef: undefined }
      }
      return copy
    })
    const data = {
      format: 'enest.ssh.export',
      version: 1,
      exportedAt: new Date().toISOString(),
      profiles,
      groups: store.state.groups,
      tags: store.allTags(),
    }
    const ok = downloadJson('enest-ssh-connections.json', data)
    try {
      await api.copyText(JSON.stringify(data, null, 2))
    } catch {
      /* ignore */
    }
    if (ok) toast('已导出', 'success')
  }

  async function importAssets() {
    const text = await promptDialog('导入 JSON', '', '')
    if (text == null || !text.trim()) return
    let data
    try {
      data = JSON.parse(text)
    } catch (e) {
      toast(err(e), 'error')
      return
    }
    const profiles = Array.isArray(data) ? data : data.profiles || []
    const groups = Array.isArray(data) ? [] : data.groups || []
    const mode = (await confirmDialog('merge 合并？取消则询问 replace', {
      title: '导入模式',
      okText: 'merge',
      cancelText: '选择 replace',
    }))
      ? 'merge'
      : await confirmDialog('整库替换？', {
          title: 'replace',
          okText: 'replace',
          danger: true,
        })
        ? 'replace'
        : null
    if (!mode) return

    if (mode === 'replace') {
      store.state.profiles = []
      store.state.groups = []
    }
    for (const g of groups) {
      if (!g || !g.id) continue
      const exists = store.state.groups.find(
        (x) => x.id === g.id || (x.name === g.name && (x.parentId || '') === (g.parentId || ''))
      )
      if (!exists) store.upsertGroup(g)
    }
    let merged = 0
    for (const p of profiles) {
      if (!p || !p.host) continue
      const key = (p.name || '') + '|' + p.host + '|' + (p.username || '')
      const found = store.state.profiles.find(
        (x) => x.name + '|' + x.host + '|' + (x.username || '') === key
      )
      if (found && mode === 'merge') {
        const next = { ...found, ...p, id: found.id, secretRef: found.secretRef || p.secretRef }
        store.upsertProfile(next)
        merged++
      } else if (!found || mode === 'replace') {
        store.upsertProfile({ ...p, id: p.id || store.uid('prof') })
      }
    }
    await store.flushAll()
    renderLeft()
    toast('导入完成 ' + merged, 'success')
  }

  async function exportSnippets() {
    downloadJson('enest-ssh-snippets.json', {
      format: 'enest.ssh.snippets',
      version: 1,
      snippets: store.state.snippets,
    })
    try {
      await api.copyText(JSON.stringify(store.state.snippets, null, 2))
    } catch {
      /* ignore */
    }
  }

  /* ========== bind UI ========== */
  function bindUi() {
    $('btn-expand-side').onclick = () => setSidebarCollapsed(false)
    $('btn-collapse-side').onclick = () => setSidebarCollapsed(true)
    $('rail-new').onclick = () => openProfileForm(null)
    $('rail-search').onclick = () => {
      setSidebarCollapsed(false)
      setTimeout(() => $('search-input')?.focus(), 50)
    }
    $('rail-drawer').onclick = () => toggleDrawer()
    $('rail-more').onclick = (ev) => showMenuFromEl(ev.currentTarget, sideMoreItems())
    $('btn-side-more').onclick = (ev) => showMenuFromEl(ev.currentTarget, sideMoreItems())

    $('btn-top-search').onclick = () => {
      setSidebarCollapsed(false)
      setTimeout(() => $('search-input')?.focus(), 50)
    }
    $('btn-top-drawer').onclick = () => toggleDrawer()
    $('btn-top-more').onclick = (ev) => showMenuFromEl(ev.currentTarget, topMoreItems())

    $('btn-drawer-close').onclick = () => setDrawerOpen(false)
    $('drawer-scrim').onclick = () => setDrawerOpen(false)
    $('btn-drawer-more').onclick = (ev) => showMenuFromEl(ev.currentTarget, drawerMoreItems())

    $('fab').onclick = () => void fabAction()

    $('search-input').addEventListener('input', (e) => {
      store.setUi({ search: e.target.value })
      renderLeft()
    })
    $('search-input').addEventListener('focus', () => renderLeft())
    $('search-input').addEventListener('blur', () => setTimeout(() => renderLeft(), 120))

    $('f-auth').addEventListener('change', updateAuthFields)
    $('btn-form-cancel').onclick = () => $('form-root').classList.remove('show')
    $('btn-form-cancel-foot').onclick = () => $('form-root').classList.remove('show')
    $('btn-form-save').onclick = () => void saveProfileForm()
    $('btn-form-test').onclick = async () => {
      const status = $('form-test-status')
      const draft = {
        id: formProfileId || 'draft',
        name: $('f-name').value.trim() || 'draft',
        host: $('f-host').value.trim(),
        port: Number($('f-port').value) || 22,
        username: $('f-username').value.trim(),
        authType: $('f-auth').value,
        secretRef: formProfileId ? store.findProfile(formProfileId)?.secretRef : undefined,
        privateKeyPath: $('f-keypath').value.trim() || undefined,
        keepAliveSec: 30,
        timeoutMs: Number($('f-timeout').value) || 10000,
      }
      if (!draft.host || !draft.username) {
        status.textContent = '请填写主机与用户名'
        return
      }
      if (!api.hasHostSsh()) {
        status.textContent = '功能未就绪'
        return
      }
      status.textContent = '测试中…'
      try {
        const payload = buildConnectPayload(draft)
        if ((draft.authType || 'password') === 'password' && !draft.secretRef) {
          const formPw = $('f-password').value
          const pw =
            formPw ||
            (await promptDialog('测试密码', '仅本次测试，不保存', ''))
          if (!pw) {
            status.textContent = '已取消：需要密码'
            return
          }
          payload.password = pw
        }
        if (api.raw?.ssh?.test) {
          const res = await api.sshTest(payload)
          status.textContent =
            (res?.latencyMs ?? res?.latency ?? '?') +
            'ms · ' +
            (res?.fingerprint || '') +
            ' · ' +
            (res?.server || res?.banner || '')
          return
        }
        // 宿主无 ssh.test：connect + 断开 作为可达性/认证测试
        const t0 = Date.now()
        const res = await api.sshConnect(payload)
        const latency = Date.now() - t0
        const sid = res && (res.sessionId || res.id)
        if (sid) {
          try {
            await api.sshDisconnect(sid)
          } catch {
            /* ignore */
          }
        }
        status.textContent =
          latency +
          'ms · ' +
          (res?.fingerprint || 'ok') +
          (res?.serverIdent ? ' · ' + res.serverIdent : '')
      } catch (e) {
        status.textContent = api.friendlyConnectError(e)
      }
    }

    $('btn-view-back').onclick = () => {
      store.setUi({ centerTab: 'term' })
      renderCenterTabs()
    }
    $('btn-view-close').onclick = () => {
      store.setUi({ centerTab: 'term' })
      renderCenterTabs()
    }

    const hint = $('hint-input')
    if (hint) {
      hint.addEventListener('input', () => {
        scheduleCompletion()
        renderHintMeta()
      })
    }
    // 焦点在终端；历史/常用走 fill → 写入终端
    window.addEventListener('keydown', (ev) => {
      const meta = ev.metaKey || ev.ctrlKey
      if (!meta) return
      const k = ev.key.toLowerCase()
      if (k === 't' && !ev.shiftKey) {
        ev.preventDefault()
        void fabAction()
      } else if (k === 'w') {
        if (document.activeElement?.tagName === 'INPUT') return
        ev.preventDefault()
        if (activeSessionId) void closeTab(activeSessionId)
      } else if (k === ' ' || ev.code === 'Space') {
        ev.preventDefault()
        termFocus()
        void runCompletion(true)
      } else if (k === 'b' && !ev.shiftKey) {
        ev.preventDefault()
        toggleDrawer()
      } else if (k === 'e' && !ev.shiftKey) {
        ev.preventDefault()
        toggleSidebar()
      }
    })

    const metricsToggle = $('metrics-toggle')
    if (metricsToggle) {
      metricsToggle.onclick = async () => {
        const s = activeSession()
        if (!s) return
        if (s.metricsOn) {
          await stopMetrics(s)
          store.setUi({ monitorOn: false })
        } else {
          store.setUi({ monitorIntervalMs: Number($('metrics-interval').value) || 5000 })
          await startMetrics(s)
        }
        renderMetrics()
      }
    }
    $('metrics-interval').value = store.state.ui.monitorIntervalMs || 5000
    $('metrics-interval').addEventListener('change', (e) => {
      store.setUi({ monitorIntervalMs: Number(e.target.value) || 5000 })
    })

    $('btn-sftp-refresh').onclick = () => void sftpRefresh()
    $('btn-sftp-up').onclick = async () => {
      const s = activeSession()
      if (!s) return
      const cur = s.sftp.path || '.'
      const parts = cur.replace(/\/+$/, '').split('/')
      parts.pop()
      s.sftp.path = parts.join('/') || '/'
      $('sftp-path').value = s.sftp.path
      await sftpRefresh()
    }
    $('sftp-path').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void sftpRefresh()
    })

    document.querySelector('.drawer-tabs').onclick = (ev) => {
      const b = ev.target.closest('button[data-tab]')
      if (!b) return
      store.setUi({ rightTab: b.dataset.tab })
      renderRight()
    }
    $('right-search').addEventListener('input', () => {
      store.setUi({ historyQuery: $('right-search').value })
      renderRight()
    })
    $('right-scope').value = store.state.ui.historyScope || 'current'
    $('right-scope').addEventListener('change', (e) => {
      store.setUi({ historyScope: e.target.value })
      renderRight()
    })

    $('right-body').onclick = async (ev) => {
      const hist = ev.target.closest('[data-hist]')
      if (hist) {
        const h = store.state.history.find((x) => x.id === hist.dataset.hist)
        if (h) await fillHint(h.command)
        return
      }
      const snip = ev.target.closest('[data-snip]')
      if (snip) {
        const s = store.state.snippets.find((x) => x.id === snip.dataset.snip)
        if (s) await fillHint(s.command)
      }
    }

    bindCtx($('right-body'), (ev) => {
      const hist = ev.target.closest('[data-hist]')
      if (hist) return historyItemMenuItems(hist.dataset.hist)
      const snip = ev.target.closest('[data-snip]')
      if (snip) return snippetMenuItems(snip.dataset.snip)
      return null
    })

    bindCtx($('session-tabs'), (ev) => {
      const tab = ev.target.closest('[data-tab]')
      if (tab) return sessionTabMenuItems(tab.dataset.tab)
      return [
        { primary: true, label: '新建连接', onAct: () => openProfileForm(null) },
        { label: '历史', onAct: () => toggleDrawer() },
      ]
    })

    window.addEventListener('keydown', (ev) => {
      const meta = ev.metaKey || ev.ctrlKey
      if (!meta) return
      const k = ev.key.toLowerCase()
      if (k === 't' && !ev.shiftKey) {
        ev.preventDefault()
        void fabAction()
      } else if (k === 'w') {
        if (document.activeElement === $('hint-input') || document.activeElement?.tagName === 'INPUT') return
        ev.preventDefault()
        if (activeSessionId) void closeTab(activeSessionId)
      } else if (k === ' ' || ev.code === 'Space') {
        ev.preventDefault()
        $('hint-input').focus()
        void runCompletion(true)
      } else if (k === 'b' && !ev.shiftKey) {
        ev.preventDefault()
        toggleDrawer()
      } else if (k === 'e' && !ev.shiftKey) {
        ev.preventDefault()
        toggleSidebar()
      }
    })

    try {
      api.raw?.onBeforeClose?.(() => store.flushAll())
    } catch {
      /* ignore */
    }
  }

  /* ========== boot ========== */
  async function boot() {
    if (window.EnestTips) window.EnestTips.bindIconTips()
    bindUi()
    bindSshEvents()
    await initPluginTheme()
    try {
      await api.setTitle('SSH')
    } catch {
      /* optional */
    }

    hostSshReady = api.hasHostSsh()

    try {
      await store.loadAll()
    } catch (e) {
      toast('加载失败：' + err(e), 'error')
    }

    setSidebarCollapsed(!!store.state.ui.sidebarCollapsed, false)
    setDrawerOpen(!!store.state.ui.drawerOpen, false)

    renderLeft()
    renderRight()
    renderSessionTabs()
    renderCenterTabs()
    mountActiveTerminal()
    renderHintMeta()
    renderTopStatus()
    updateFab()

    if (!api.raw) toast('预览模式：功能未就绪', 'warn')
    else if (!hostSshReady) toast('功能未就绪', 'warn')

    setInterval(renderTopStatus, 30000)
  }

  void boot()
})()
