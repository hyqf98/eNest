/**
 * api.js — window.enest 适配层
 * - storage / vault / db.* / ui / clipboard / notify
 * - 宿主可能尚未暴露 db.* / vault.*：按 Spec 方法名调用，HOST_LAG 时 UI 降级
 */

export const api = window.enest || window.zapi || null

export function hasApi() {
  return !!api
}

/** 深路径调用 host API；方法不存在时抛 HOST_LAG */
export async function hostCall(path, args = []) {
  const parts = String(path).split('.')
  let parent = api
  if (!parent) {
    const err = new Error('eNest API 不可用')
    err.code = 'NO_API'
    throw err
  }
  for (let i = 0; i < parts.length - 1; i++) {
    parent = parent?.[parts[i]]
  }
  const fn = parent?.[parts[parts.length - 1]]
  if (typeof fn !== 'function') {
    const err = new Error('功能未就绪')
    err.code = 'HOST_LAG'
    throw err
  }
  try {
    return await fn.apply(parent, args)
  } catch (e) {
    const msg = String(e?.message || e)
    if (msg.includes('unknown method') || msg.includes('permission denied')) {
      const err = new Error(msg)
      err.code = msg.includes('permission') ? 'PERM' : 'HOST_LAG'
      throw err
    }
    throw e
  }
}

export function hostLag(err) {
  return err?.code === 'HOST_LAG' || err?.code === 'NO_API' || err?.code === 'PERM'
}

export async function toast(message, type = 'info') {
  try {
    await api?.ui?.toast?.({ message, type })
  } catch {
    /* ignore */
  }
}

export async function notify(payload) {
  try {
    return await api?.notify?.(payload)
  } catch {
    return false
  }
}

export async function setTitle(title) {
  try {
    return await api?.ui?.setTitle?.(title)
  } catch {
    return false
  }
}

export async function clipboardWrite(text) {
  try {
    return await api?.clipboard?.writeText?.(text)
  } catch {
    return false
  }
}

export async function openExternal(url) {
  try {
    return await api?.shell?.openExternal?.(url)
  } catch {
    return false
  }
}

/* ── storage KV（Spec 2.0 键空间）── */

export const StorageKeys = {
  connections: 'db.connections',
  sessions: 'db.sessions',
  activeSessionId: 'db.activeSessionId',
  queryHistory: 'db.queryHistory',
  completionUsage: 'db.completionUsage',
  ui: 'db.ui'
}

export async function storageGet(key, fallback = null) {
  try {
    const v = await api?.storage?.get?.(key)
    return v === undefined || v === null ? fallback : v
  } catch {
    return fallback
  }
}

export async function storageSet(key, value) {
  try {
    return await api?.storage?.set?.(key, value)
  } catch (e) {
    console.warn('storage.set failed', key, e)
    return false
  }
}

export async function storageRemove(key) {
  try {
    return await api?.storage?.remove?.(key)
  } catch {
    return false
  }
}

/* ── vault（密钥只经 set → secretRef）── */

export const Vault = {
  async set(key, secret) {
    return hostCall('vault.set', [key, String(secret ?? '')])
  },
  async has(secretRef) {
    return hostCall('vault.has', [secretRef])
  },
  async remove(secretRef) {
    return hostCall('vault.remove', [secretRef])
  }
}

/* ── db.* Host API（Spec DB-K）── */

export const DbHost = {
  dialectsList() {
    return hostCall('db.dialects.list', []).catch((e) => {
      if (e?.code === 'HOST_LAG') return hostCall('db.dialectsList', [])
      throw e
    })
  },
  test(input) {
    return hostCall('db.test', [input])
  },
  open(input) {
    // 宿主接受 { config, sessionKey } 或扁平 config
    return hostCall('db.open', [input])
  },
  close(sessionKey) {
    return hostCall('db.close', [typeof sessionKey === 'string' ? sessionKey : sessionKey?.sessionKey])
  },
  listSessions() {
    return hostCall('db.listSessions', [])
  },
  pickSqliteFile() {
    return hostCall('db.pickSqliteFile', [])
  },
  pickImportFile() {
    return hostCall('db.pickImportFile', [])
  },
  execute(req) {
    return hostCall('db.execute', [req])
  },
  explain(req) {
    return hostCall('db.explain', [{ sessionKey: req?.sessionKey, sql: req?.sql ?? '' }])
  },
  cancel(req) {
    const sid = typeof req === 'string' ? req : req?.sessionKey
    return hostCall('db.cancel', [sid ?? req])
  },
  /** Spec：方法名 completion.suggest；preload 同时暴露函数形 */
  completion(req) {
    return hostCall('db.completion.suggest', [req]).catch((e) => {
      if (e?.code === 'HOST_LAG' || e?.code === 'NO_API') {
        try {
          const fn = api?.db?.completion
          if (typeof fn === 'function') return fn.call(api.db, req)
          const suggest = api?.db?.completion?.suggest
          if (typeof suggest === 'function') return suggest.call(api.db.completion, req)
        } catch {
          /* fallthrough */
        }
      }
      throw e
    })
  },
  applyChanges(req) {
    return hostCall('db.applyChanges', [req])
  },
  importPreview(req) {
    return hostCall('db.importPreview', [req])
  },
  importRun(req) {
    return hostCall('db.importRun', [req])
  },
  schema: {
    tree(req) {
      return hostCall('db.schema.tree', [req])
    },
    async databases(req) {
      const t = await DbHost.schema.tree({ ...req, parent: 'root', node: { type: 'root' } })
      return Array.isArray(t) ? t.filter((n) => n?.type === 'database' || n?.name) : []
    },
    async schemas(req) {
      return DbHost.schema.tree({ ...req, parent: 'database', node: { type: 'database' } })
    },
    async tables(req) {
      const parent = req?.parent || (req?.schema ? 'schema' : 'database')
      return DbHost.schema.tree({ ...req, parent, node: { type: parent } })
    },
    async columns(req) {
      return DbHost.schema.tree({
        ...req,
        parent: 'table',
        node: { type: 'table', table: req?.table || req?.name }
      })
    },
    describe(req) {
      return hostCall('db.schema.describe', [req])
    },
    async tableDetail(req) {
      // 优先 describe；失败则用 tree 列信息
      try {
        return await hostCall('db.schema.describe', [req])
      } catch (e) {
        if (hostLag(e)) throw e
        const cols = await DbHost.schema.columns(req)
        return {
          name: req?.table || req?.name,
          columns: Array.isArray(cols)
            ? cols.map((c) => ({
                name: c.name || c.label,
                type: c.type || c.dataType,
                comment: c.comment,
                pk: c.pk || c.primaryKey,
                primaryKey: c.primaryKey || c.pk
              }))
            : []
        }
      }
    },
    ddl(req) {
      return hostCall('db.schema.ddl', [req])
    }
  }
}

/** 组装连接入参（密钥只传 secretRef） */
export function toConnectionInput(conn, overrides = {}) {
  const filePath = conn.filePath || conn.sqlitePath || conn.options?.file
  return {
    connectionId: conn.id,
    driver: conn.driver,
    host: conn.host,
    port: conn.port,
    database: conn.database,
    username: conn.username,
    secretRef: conn.secretRef || undefined,
    options: {
      ...(conn.options || {}),
      readOnly: conn.readOnly ?? conn.options?.readOnly ?? false,
      env: conn.env ?? conn.options?.env,
      schema: conn.schema ?? conn.options?.schema,
      createIfMissing: conn.createIfMissing ?? conn.options?.createIfMissing,
      file: filePath,
      org: conn.org || conn.options?.org,
      bucket: conn.bucket || conn.options?.bucket,
      requireConfirm: conn.options?.requireConfirm
    },
    readOnly: !!conn.readOnly,
    env: conn.env,
    filePath,
    sqlitePath: conn.sqlitePath || conn.filePath,
    createIfMissing: !!(conn.createIfMissing ?? conn.options?.createIfMissing),
    org: conn.org || conn.options?.org,
    bucket: conn.bucket || conn.options?.bucket,
    ...overrides
  }
}

export function sessionKeyOf(connectionId, database) {
  return database ? `${connectionId}::${database}` : String(connectionId || '')
}

const SHELL_TOKEN_KEYS = [
  '--bg',
  '--surface',
  '--surface-2',
  '--surface-3',
  '--border',
  '--border-strong',
  '--text',
  '--text-2',
  '--text-3',
  '--accent',
  '--accent-soft',
  '--ok',
  '--ok-soft',
  '--danger',
  '--danger-soft',
  '--warn',
  '--radius-xl',
  '--radius-lg',
  '--radius-md',
  '--radius-sm',
  '--radius-pill',
  '--shadow-soft',
  '--shadow-float',
  '--font',
  '--mono'
]

let followShellTheme = true

export function setFollowShellTheme(v) {
  followShellTheme = v !== false
  return followShellTheme
}

export function getFollowShellTheme() {
  return followShellTheme
}

/** 注册壳子设置页（followShellTheme 默认 true） */
export async function registerPluginSettings() {
  try {
    await api?.settings?.register?.({
      id: 'database.prefs',
      title: '数据库',
      items: [
        {
          key: 'followShellTheme',
          type: 'switch',
          label: '跟随壳子主题',
          default: true
        }
      ]
    })
  } catch {
    /* 权限未声明 / 宿主滞后时忽略 */
  }
  try {
    const v = await api?.settings?.get?.('followShellTheme')
    if (v !== undefined && v !== null) setFollowShellTheme(v !== false)
  } catch {
    /* ignore */
  }
}

export async function applyShellTheme() {
  const apply = (tokens, mode) => {
    if (!followShellTheme) return
    if (!tokens || typeof tokens !== 'object') return
    const root = document.documentElement
    const pick = (...keys) => {
      for (const k of keys) {
        const v = tokens[k] ?? tokens[k.replace(/^--/, '')]
        if (v !== undefined && v !== null && v !== '') return v
      }
      return null
    }
    for (const key of SHELL_TOKEN_KEYS) {
      const bare = key.replace(/^--/, '')
      const aliases = [key, bare]
      if (key === '--surface-2') aliases.push('--color-surface-2', 'surface2')
      if (key === '--surface-3') aliases.push('--color-surface-3', 'surface3')
      if (key === '--accent-soft') aliases.push('accentSoft')
      if (key === '--ok-soft') aliases.push('--okSoft', 'okSoft')
      if (key === '--danger-soft') aliases.push('--dangerSoft', 'dangerSoft')
      if (key === '--shadow-soft') aliases.push('shadowSoft')
      if (key === '--shadow-float') aliases.push('shadowFloat')
      if (key === '--border-strong') aliases.push('--borderStrong', 'borderStrong')
      if (key === '--mono') aliases.push('--font-mono', 'fontMono', 'mono')
      if (key === '--font') aliases.push('font', 'fontFamily')
      const v = pick(...aliases)
      if (v) root.style.setProperty(key, v)
    }
    // legacy alias used by editor / grid
    const mono = pick('--mono', '--font-mono', 'fontMono', 'mono')
    if (mono) root.style.setProperty('--font-mono', mono)

    const m = mode || tokens.__mode || tokens.mode
    if (m === 'light' || m === 'dark') {
      root.dataset.theme = m
      root.dataset.scheme = m
    }
  }

  const restoreLocal = () => {
    // 关闭跟随主题时清掉 inline token，回落 CSS :root / data-theme
    const root = document.documentElement
    for (const key of [...SHELL_TOKEN_KEYS, '--font-mono']) {
      root.style.removeProperty(key)
    }
  }

  const handle = (payload) => {
    if (!followShellTheme) {
      restoreLocal()
      return
    }
    if (!payload) return
    const tokens = payload.tokens || payload
    apply(tokens, payload.mode)
  }

  try {
    const t =
      (await api?.theme?.getTokens?.()) || (await api?.ui?.getThemeTokens?.())
    if (t?.tokens) handle({ ...t, mode: t.mode })
    else if (t && !t.tokens && typeof t === 'object') handle(t)
  } catch {
    /* ignore */
  }
  try {
    api?.ui?.onThemeChange?.(handle)
    api?.theme?.onThemeChange?.(handle)
  } catch {
    /* ignore */
  }
}

/** 宿主保存对话框（可能尚未实现）→ 失败回落剪贴板 */
export async function saveTextFile(filename, content, { successMsg } = {}) {
  const attempts = [
    () => hostCall('shell.saveTextFile', [{ defaultName: filename, filename, content }]),
    () => hostCall('shell.saveFileDialog', [{ defaultName: filename, content }]),
    () => hostCall('shell.saveFile', [{ filename, content, defaultName: filename }]),
    () => hostCall('shell.exportFile', [{ filename, content }])
  ]
  for (const fn of attempts) {
    try {
      const r = await fn()
      if (r !== false && r !== null && r !== undefined) {
        await toast(successMsg || `已保存 ${filename}`, 'success')
        return { ok: true, via: 'host', path: r?.path || r }
      }
    } catch (e) {
      if (!hostLag(e)) {
        await toast(String(e.message || e), 'error')
        return { ok: false, error: e }
      }
    }
  }
  const copied = await clipboardWrite(content)
  if (copied) {
    await toast(`${filename} 已复制到剪贴板（系统保存暂不可用）`, 'warn')
    return { ok: true, via: 'clipboard' }
  }
  await toast('导出失败：系统保存与剪贴板均不可用', 'error')
  return { ok: false }
}
