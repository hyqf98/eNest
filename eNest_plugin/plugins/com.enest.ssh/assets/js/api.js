/**
 * com.enest.ssh — 宿主 API 安全封装
 * 方法名对齐 docs/compose/spec/ssh-db-plugins.md（SSH-A–J / 2.0 / 权限表）
 * 宿主可能尚未实现：所有调用 try/catch，错误原样抛出供 UI 展示。
 */
;(function (global) {
  const api = global.enest || global.zapi || null

  function toast(message, type) {
    try {
      const t = api?.ui?.toast || api?.toast
      if (t) {
        const r = t.call(api.ui || api, { message: String(message), type: type || 'info' })
        if (r && typeof r.catch === 'function') r.catch(() => {})
        return
      }
    } catch (_) { /* host toast optional */ }
  }

  function errMessage(e) {
    return String((e && e.message) || e || '未知错误')
  }

  function missing(name) {
    return new Error('功能未就绪')
  }

  function has(fn) {
    return typeof fn === 'function'
  }

  /* —— storage KV —— */
  async function storageGet(key, fallback) {
    if (!has(api?.storage?.get)) return fallback
    try {
      const v = await api.storage.get(key)
      return v === undefined || v === null ? fallback : v
    } catch (e) {
      throw new Error('storage.get(' + key + '): ' + errMessage(e))
    }
  }

  async function storageSet(key, value) {
    if (!has(api?.storage?.set)) throw missing('storage.set')
    return api.storage.set(key, value)
  }

  async function storageRemove(key) {
    if (!has(api?.storage?.remove)) throw missing('storage.remove')
    return api.storage.remove(key)
  }

  /* —— vault —— */
  async function vaultSet(key, secret) {
    if (!has(api?.vault?.set)) throw missing('vault.set')
    const res = await api.vault.set(key, String(secret))
    const ref = res && (res.secretRef || res.ref || res)
    if (res && typeof res === 'object' && res.secretRef) return res
    if (typeof ref === 'string') return { secretRef: ref }
    return res || {}
  }

  async function vaultHas(secretRef) {
    if (!has(api?.vault?.has) || !secretRef) return false
    try {
      return Boolean(await api.vault.has(secretRef))
    } catch {
      return false
    }
  }

  async function vaultRemove(secretRef) {
    if (!has(api?.vault?.remove) || !secretRef) return false
    return api.vault.remove(secretRef)
  }

  /* —— ssh sessions —— */
  async function sshConnect(payload) {
    if (!has(api?.ssh?.connect)) throw missing('ssh.connect')
    return api.ssh.connect(payload)
  }

  /** preload 契约：write(sessionId, data)；兼容对象形态入参 */
  async function sshWrite(sessionId, data) {
    if (!has(api?.ssh?.write)) throw missing('ssh.write')
    if (sessionId && typeof sessionId === 'object') {
      return api.ssh.write(String(sessionId.sessionId ?? ''), String(sessionId.data ?? ''))
    }
    return api.ssh.write(String(sessionId ?? ''), String(data ?? ''))
  }

  async function sshResize(sessionId, cols, rows) {
    if (!has(api?.ssh?.resize)) throw missing('ssh.resize')
    if (sessionId && typeof sessionId === 'object') {
      return api.ssh.resize(
        String(sessionId.sessionId ?? ''),
        Number(sessionId.cols) || 80,
        Number(sessionId.rows) || 24
      )
    }
    return api.ssh.resize(String(sessionId ?? ''), Number(cols) || 80, Number(rows) || 24)
  }

  async function sshDisconnect(sessionId) {
    if (!has(api?.ssh?.disconnect)) throw missing('ssh.disconnect')
    const id = sessionId && typeof sessionId === 'object' ? sessionId.sessionId : sessionId
    return api.ssh.disconnect(String(id ?? ''))
  }

  async function sshListSessions() {
    if (!has(api?.ssh?.listSessions)) throw missing('ssh.listSessions')
    const r = await api.ssh.listSessions()
    return Array.isArray(r) ? r : (r && (r.sessions || r.items)) || []
  }

  async function sshExec(sessionId, command, opts) {
    if (!has(api?.ssh?.exec)) throw missing('ssh.exec')
    if (sessionId && typeof sessionId === 'object') {
      return api.ssh.exec(sessionId)
    }
    return api.ssh.exec({ sessionId, command, ...(opts || {}) })
  }

  /** 测试连接：宿主可能提供 ssh.test；否则由调用方降级 */
  async function sshTest(payload) {
    if (!has(api?.ssh?.test)) throw missing('ssh.test')
    return api.ssh.test(payload)
  }

  /* —— metrics —— */
  async function metricsStart(sessionId, intervalMs) {
    const m = api?.ssh?.metrics
    if (!has(m?.start)) throw missing('ssh.metrics.start')
    return m.start({ sessionId, intervalMs: intervalMs || 5000 })
  }

  async function metricsStop(sessionId) {
    const m = api?.ssh?.metrics
    if (!has(m?.stop)) return false
    try {
      return await m.stop({ sessionId })
    } catch {
      return m.stop(sessionId)
    }
  }

  /* —— completion —— */
  /**
   * 宿主契约：suggest({ sessionId, line, cursor?, history?, snippets? })
   * prefix 作为 line 的兼容别名一并下发。
   */
  async function completionSuggest(sessionId, prefixOrInput, extra) {
    const c = api?.ssh?.completion
    if (!has(c?.suggest)) throw missing('ssh.completion.suggest')
    if (prefixOrInput && typeof prefixOrInput === 'object') {
      const o = prefixOrInput
      const line = o.line != null ? String(o.line) : String(o.prefix ?? '')
      return c.suggest({ ...o, line, prefix: line })
    }
    const line = String(prefixOrInput ?? '')
    return c.suggest({ sessionId, line, prefix: line, ...(extra || {}) })
  }

  /** 宿主补全项 → 插件 hint bar 项（label/insertText/kind/dangerous） */
  function mapHostCompletionItems(res) {
    const raw = (res && (res.items || res.suggestions || res.candidates)) || []
    if (!Array.isArray(raw)) return []
    return raw
      .map((it) => {
        if (typeof it === 'string') {
          return { kind: 'path', text: it, detail: '', dangerous: false }
        }
        const dangerous = it.dangerous != null && it.dangerous !== false && it.dangerous !== 0
        return {
          kind: it.kind || 'cmd',
          text: String(it.insertText || it.label || it.text || it.value || it.name || ''),
          detail: it.detail || '',
          dangerous: Boolean(dangerous),
          dangerDetail: typeof it.dangerous === 'string' ? it.dangerous : '',
        }
      })
      .filter((it) => it.text)
  }

  /** 连接/认证错误 → 用户可读文案（不暴露 vault/secretRef 术语） */
  function friendlyConnectError(e) {
    const msg = errMessage(e)
    const low = msg.toLowerCase()
    if (!api || !has(api?.ssh?.connect)) return '功能未就绪：SSH 宿主不可用'
    if (msg.includes('功能未就绪')) return msg
    if (
      low.includes('permission denied') ||
      low.includes('authentication') ||
      low.includes('all configured authentication methods failed') ||
      low.includes('publickey') ||
      low.includes('bad authentication')
    ) {
      return '认证失败：请检查用户名 / 密码 / 私钥'
    }
    if (low.includes('password secret required') || low.includes('secretref')) {
      return '认证失败：尚未配置登录密码，请编辑连接保存，或在连接时输入'
    }
    if (low.includes('private key not found') || low.includes('privatekeypath')) {
      return '认证失败：私钥路径无效或不可读'
    }
    if (low.includes('ssh_auth_sock') || low.includes('ssh-agent') || low.includes('agent unavailable')) {
      return '认证失败：系统 SSH Agent 不可用'
    }
    if (low.includes('econnrefused') || low.includes('connection refused')) {
      return '网络不可达：请检查主机、端口或防火墙'
    }
    if (low.includes('etimedout') || low.includes('timeout') || low.includes('timed out')) {
      return '连接超时：请检查网络或目标主机'
    }
    if (low.includes('enotfound') || low.includes('getaddrinfo')) {
      return '域名解析失败：请检查主机名'
    }
    if (low.includes('host and username required')) {
      return '连接配置无效：缺少主机或用户名'
    }
    return '连接失败：' + msg
  }

  function isAuthError(e) {
    const low = errMessage(e).toLowerCase()
    return (
      low.includes('permission denied') ||
      low.includes('authentication') ||
      low.includes('password secret required') ||
      low.includes('private key not found') ||
      low.includes('ssh_auth_sock')
    )
  }

  async function notify(payload) {
    if (!has(api?.notify)) return false
    try {
      return await api.notify(payload)
    } catch {
      return false
    }
  }

  /* —— sftp —— */
  async function sftpList(sessionId, path) {
    const s = api?.ssh?.sftp
    if (!has(s?.list)) throw missing('ssh.sftp.list')
    if (sessionId && typeof sessionId === 'object') return s.list(sessionId)
    return s.list({ sessionId, path })
  }

  async function sftpUpload(sessionId, localPath, remotePath) {
    const s = api?.ssh?.sftp
    if (!has(s?.upload)) throw missing('ssh.sftp.upload')
    return s.upload({ sessionId, localPath, remotePath })
  }

  async function sftpDownload(sessionId, remotePath, localPath) {
    const s = api?.ssh?.sftp
    if (!has(s?.download)) throw missing('ssh.sftp.download')
    return s.download({ sessionId, remotePath, localPath })
  }

  /**
   * 宿主文件选择器（Spec SSH-A4/G3）。
   * opts: { mode: 'file'|'dir' } 或 { properties: [...] }；宿主要求 properties。
   * 返回 { path } 或 null。
   */
  async function pickLocalFile(opts) {
    const pick = api?.ssh?.pickLocalFile || api?.ssh?.pickFile
    if (!has(pick)) return null
    try {
      let callOpts = { properties: ['openFile'] }
      if (opts && typeof opts === 'object') {
        if (Array.isArray(opts.properties) && opts.properties.length) {
          callOpts = { properties: opts.properties }
        } else if (opts.mode === 'dir' || opts.mode === 'directory') {
          callOpts = { properties: ['openDirectory'] }
        } else if (opts.mode === 'file') {
          callOpts = { properties: ['openFile'] }
        }
      }
      const r = await pick(callOpts)
      if (!r) return null
      return typeof r === 'string' ? { path: r } : r
    } catch {
      return null
    }
  }

  /* —— ui / clipboard / theme / settings —— */
  async function setTitle(t) {
    try {
      const f = api?.ui?.setTitle || api?.setTitle
      if (has(f)) await f.call(api.ui || api, t)
    } catch (_) { /* optional */ }
  }

  async function copyText(text) {
    if (!has(api?.clipboard?.writeText)) throw missing('clipboard.writeText')
    return api.clipboard.writeText(String(text))
  }

  function applyThemeTokens(tokens) {
    if (!tokens) return
    const root = document.documentElement
    for (const [k, v] of Object.entries(tokens)) {
      if (typeof v === 'string' && k.startsWith('--')) root.style.setProperty(k, v)
    }
    document.documentElement.dataset.themeApplied = '1'
  }

  function clearInlineThemeTokens() {
    const root = document.documentElement
    const keys = [
      '--bg','--surface','--surface-2','--surface-3','--border','--border-strong',
      '--text','--text-2','--text-3','--accent','--accent-soft','--ok','--ok-soft',
      '--danger','--danger-soft','--warn','--warn-soft',
      '--radius-md','--radius-sm','--shadow-soft','--shadow-float','--font','--mono','--term-bg'
    ]
    for (const k of keys) root.style.removeProperty(k)
  }

  /** 本地兜底色板（followShellTheme=false 时）— 对齐 shell tokens 预设 */
  const FALLBACK_PALETTE = {
    light: {
      '--bg': '#f3f4f6',
      '--surface': '#ffffff',
      '--surface-2': '#f0f2f5',
      '--surface-3': '#e8ebf0',
      '--border': 'rgba(15,23,42,0.08)',
      '--border-strong': 'rgba(15,23,42,0.14)',
      '--text': '#0f1420',
      '--text-2': '#5c6578',
      '--text-3': '#8b93a5',
      '--accent': '#1a1f2e',
      '--accent-soft': 'rgba(26,31,46,0.08)',
      '--ok': '#0d9f6e',
      '--ok-soft': 'rgba(13,159,110,0.1)',
      '--danger': '#e11d48',
      '--danger-soft': 'rgba(225,29,72,0.1)',
      '--warn': '#c47b12',
      '--warn-soft': 'rgba(196,123,18,0.12)',
    },
    dark: {
      '--bg': '#0d1118',
      '--surface': '#161b24',
      '--surface-2': '#1c2230',
      '--surface-3': '#252d3d',
      '--border': 'rgba(255,255,255,0.09)',
      '--border-strong': 'rgba(255,255,255,0.16)',
      '--text': '#f3f5f9',
      '--text-2': '#b4bdcf',
      '--text-3': '#7c879c',
      '--accent': '#e8ecf4',
      '--accent-soft': 'rgba(232,236,244,0.1)',
      '--ok': '#3dd68c',
      '--ok-soft': 'rgba(61,214,140,0.14)',
      '--danger': '#ff7a8e',
      '--danger-soft': 'rgba(255,122,142,0.14)',
      '--warn': '#f5b942',
      '--warn-soft': 'rgba(245,185,66,0.14)',
    },
  }

  function systemMode() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    } catch {
      return 'dark'
    }
  }

  function applyFallbackPalette(mode) {
    const m = mode === 'light' ? 'light' : 'dark'
    applyThemeTokens(FALLBACK_PALETTE[m])
    document.documentElement.dataset.theme = m
  }

  async function settingsRegister(section) {
    try {
      const f = api?.settings?.register
      if (!has(f)) return false
      return Boolean(await f.call(api.settings, section))
    } catch (_) {
      return false
    }
  }

  async function settingsGet(key, fallback) {
    try {
      const f = api?.settings?.get
      if (!has(f)) return fallback
      const v = await f.call(api.settings, key)
      return v === undefined || v === null ? fallback : v
    } catch (_) {
      return fallback
    }
  }

  async function settingsSet(key, value) {
    try {
      const f = api?.settings?.set
      if (!has(f)) return false
      return Boolean(await f.call(api.settings, key, value))
    } catch (_) {
      return false
    }
  }

  /**
   * 初始化主题。
   * followShellTheme=true  → 读取壳子 tokens 并订阅 onThemeChange
   * followShellTheme=false → 使用 preferredColorScheme / 系统偏好本地兜底色板
   */
  async function initTheme(onChange, opts) {
    const follow =
      opts && typeof opts.followShellTheme === 'boolean'
        ? opts.followShellTheme
        : true

    if (!follow) {
      clearInlineThemeTokens()
      const mode = (opts && opts.preferredMode) || systemMode()
      applyFallbackPalette(mode)
      // 系统主题变化时更新兜底
      try {
        const mq = window.matchMedia('(prefers-color-scheme: dark)')
        const handler = () => applyFallbackPalette(systemMode())
        if (mq.addEventListener) mq.addEventListener('change', handler)
        else if (mq.addListener) mq.addListener(handler)
      } catch (_) { /* ignore */ }
      if (typeof onChange === 'function') onChange({ mode, tokens: FALLBACK_PALETTE[mode] })
      return
    }

    // 兜底 CSS 变量已在 :root；壳子注入后覆盖
    try {
      const get = api?.theme?.getTokens || api?.ui?.getThemeTokens
      if (has(get)) {
        const res = await (api.theme?.getTokens ? api.theme.getTokens() : api.ui.getThemeTokens())
        if (res && res.tokens) applyThemeTokens(res.tokens)
        if (res && res.mode) document.documentElement.dataset.theme = res.mode
      }
    } catch (_) { /* fallback palette in CSS */ }
    try {
      const off = api?.ui?.onThemeChange
      if (has(off)) {
        off.call(api.ui, (ev) => {
          applyThemeTokens(ev && ev.tokens)
          if (ev && ev.mode) document.documentElement.dataset.theme = ev.mode
          if (typeof onChange === 'function') onChange(ev)
        })
      }
    } catch (_) { /* ignore */ }
  }

  function on(event, cb) {
    if (!has(api?.on)) return () => {}
    api.on(event, cb)
    return () => {
      try { api.off && api.off(event, cb) } catch (_) { /* ignore */ }
    }
  }

  global.SshApi = {
    raw: api,
    toast,
    errMessage,
    friendlyConnectError,
    isAuthError,
    mapHostCompletionItems,
    notify,
    hasHostSsh: () => has(api?.ssh?.connect),
    hasVault: () => has(api?.vault?.set),
    storageGet,
    storageSet,
    storageRemove,
    vaultSet,
    vaultHas,
    vaultRemove,
    sshConnect,
    sshWrite,
    sshResize,
    sshDisconnect,
    sshListSessions,
    sshExec,
    sshTest,
    metricsStart,
    metricsStop,
    completionSuggest,
    sftpList,
    sftpUpload,
    sftpDownload,
    pickLocalFile,
    setTitle,
    copyText,
    initTheme,
    applyThemeTokens,
    applyFallbackPalette,
    settingsRegister,
    settingsGet,
    settingsSet,
    systemMode,
    on,
  }
})(window)
