/**
 * agentConfigService — AI CLI 配置白名单读写宿主服务（config.agent 权限）
 * 职责：维护 10 个 AI CLI 应用的配置路径白名单（硬编码，禁止任意路径）；
 *      读配置原文 + 解析结果；写采用「最小侵入合并」（JSON 顶层键替换 /
 *      TOML 顶层键/表替换，保留注释与未触及内容）；写前自动快照到
 *      ~/.eNest/agent-config-backups/<app>/<timestamp>，保留最近 20 份；
 *      支持从快照恢复。
 * 语义移植自 farion1231/cc-switch（Rust/Tauri）的 config 适配层
 * （app_config.rs / codex_config.rs / grok_config.rs / opencode_config.rs 等）：
 * - claude：~/.claude/settings.json（JSON，env 覆盖型）
 * - claude-desktop：~/Library/Application Support/Claude/claude_desktop_config.json
 * - codex：~/.codex/config.toml（TOML）+ ~/.codex/auth.json（JSON）
 * - gemini-cli：~/.gemini/settings.json（JSON）
 * - grok-build：~/.grok/config.toml（TOML）
 * - opencode：~/.opencode/opencode.json（JSON）
 * - openclaw：~/.openclaw/openclaw.json（JSON）
 * - hermes：~/.hermes/config.yaml（YAML，仅按行替换顶层 key，保守处理）
 * - pi：~/.pi/pi.json（JSON）
 * - minimax-code：~/.mcode/mcode.json（JSON）
 * 被 pluginHandlers 分发调用（method 以 agent.* 开头）。
 * 关键依赖：node:fs / node:path / node:os / pathsService（快照根）。
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getAppPathsRoot } from '@main/paths/pathsService'
import { logWarn } from '@main/logs/logService'

/** 配置文件格式（决定 write 合并策略） */
export type AgentConfigFormat = 'json' | 'toml' | 'yaml'

export interface AgentAdapter {
  /** 应用标识（白名单键） */
  app: string
  /** 展示名 */
  name: string
  /** 配置文件绝对路径白名单（~ 已展开） */
  configPaths: string[]
  /** 各文件格式（与 configPaths 对齐） */
  formats: AgentConfigFormat[]
  /** 当前活跃检测：默认按主配置文件存在判定，可覆盖更精细语义 */
  isActive?(): boolean
  /** 会话日志根目录白名单（只读；存在才允许 sessions.list/read 进入） */
  sessionDirs?: string[]
  /**
   * 会话目录的相对白名单校验（只允许进入白名单根目录下的已知结构）。
   * 缺省接受 sessionDirs 下任意相对路径（不越过根、拒绝 .. 与符号链接）。
   */
  sessionMatch?(relPath: string): boolean
}

const HOME = homedir()
const MAC_CLAUDE_DESKTOP = join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
const CLAUDE_DIR = join(HOME, '.claude')

/**
 * claude-code 会话目录结构白名单（对齐 cc-switch session_usage / session_manager）：
 * 白名单根即 ~/.claude/projects，相对路径形如：
 * <项目目录>/xxx.jsonl（主会话）或 <项目目录>/<sessionId>/subagents/…/xxx.jsonl（子 agent）
 * 项目目录为编码后的路径（本机实测可为单段 `-` 或多段编码），至少一段且文件 .jsonl 结尾。
 */
function claudeSessionMatch(relPath: string): boolean {
  const segs = relPath.split('/').filter(Boolean)
  return segs.length >= 2 && segs[segs.length - 1].endsWith('.jsonl')
}

/** 10 应用白名单（路径展开硬编码；新增应用必须改此处） */
export const AGENT_ADAPTERS: AgentAdapter[] = [
  {
    app: 'claude-code',
    name: 'Claude Code',
    configPaths: [join(CLAUDE_DIR, 'settings.json'), join(HOME, '.claude.json')],
    formats: ['json', 'json'],
    // 活跃 = settings.json 存在（env 注入型配置；cc-switch 切换器活跃时含 127.0.0.1 代理指向）
    isActive: () => existsSync(join(CLAUDE_DIR, 'settings.json')),
    sessionDirs: [join(CLAUDE_DIR, 'projects')],
    sessionMatch: claudeSessionMatch
  },
  {
    app: 'claude-desktop',
    name: 'Claude Desktop',
    configPaths: [MAC_CLAUDE_DESKTOP],
    formats: ['json'],
    isActive: () => existsSync(MAC_CLAUDE_DESKTOP)
  },
  {
    app: 'codex',
    name: 'Codex CLI',
    configPaths: [join(HOME, '.codex', 'config.toml'), join(HOME, '.codex', 'auth.json')],
    formats: ['toml', 'json'],
    sessionDirs: [join(HOME, '.codex', 'sessions'), join(HOME, '.codex', 'archived_sessions')],
    // 活跃 = auth.json 存在登录材料（tokens 或 OPENAI_API_KEY）
    isActive: () => {
      const authPath = join(HOME, '.codex', 'auth.json')
      if (!existsSync(authPath)) return false
      try {
        const auth = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, unknown>
        if (auth.auth_mode === 'chatgpt' && auth.tokens && typeof auth.tokens === 'object') return true
        return typeof auth.OPENAI_API_KEY === 'string' && (auth.OPENAI_API_KEY as string).length > 0
      } catch {
        return false
      }
    }
  },
  {
    app: 'gemini-cli',
    name: 'Gemini CLI',
    configPaths: [join(HOME, '.gemini', 'settings.json')],
    formats: ['json'],
    isActive: () => existsSync(join(HOME, '.gemini', 'settings.json')),
    sessionDirs: [join(HOME, '.gemini', 'tmp')]
  },
  {
    app: 'grok-build',
    name: 'Grok Build',
    configPaths: [join(HOME, '.grok', 'config.toml')],
    formats: ['toml'],
    isActive: () => existsSync(join(HOME, '.grok', 'config.toml'))
  },
  {
    app: 'opencode',
    name: 'OpenCode',
    configPaths: [join(HOME, '.opencode', 'opencode.json')],
    formats: ['json'],
    isActive: () => existsSync(join(HOME, '.opencode', 'opencode.json')),
    sessionDirs: [join(HOME, '.local', 'share', 'opencode')]
  },
  {
    app: 'openclaw',
    name: 'OpenClaw',
    configPaths: [join(HOME, '.openclaw', 'openclaw.json')],
    formats: ['json'],
    isActive: () => existsSync(join(HOME, '.openclaw', 'openclaw.json')),
    sessionDirs: [join(HOME, '.openclaw', 'sessions')]
  },
  {
    app: 'hermes',
    name: 'Hermes',
    configPaths: [join(HOME, '.hermes', 'config.yaml')],
    formats: ['yaml'],
    isActive: () => existsSync(join(HOME, '.hermes', 'config.yaml'))
  },
  {
    app: 'pi',
    name: 'Pi',
    configPaths: [join(HOME, '.pi', 'pi.json')],
    formats: ['json'],
    isActive: () => existsSync(join(HOME, '.pi', 'pi.json')),
    sessionDirs: [join(HOME, '.pi', 'sessions')]
  },
  {
    app: 'minimax-code',
    name: 'MiniMax Code',
    configPaths: [join(HOME, '.mcode', 'mcode.json')],
    formats: ['json'],
    isActive: () => existsSync(join(HOME, '.mcode', 'mcode.json'))
  }
]

function findAdapter(app: string): AgentAdapter {
  const adapter = AGENT_ADAPTERS.find(a => a.app === app)
  if (!adapter) {
    const allowed = AGENT_ADAPTERS.map(a => a.app).join(', ')
    throw new Error(`unknown app "${app}" (allowed: ${allowed})`)
  }
  return adapter
}

// —— 最小侵入合并（纯函数，单测覆盖）——

/**
 * JSON 最小侵入合并：解析 → 只替换/插入 changes 中的顶层键 → 保留对象键序
 * 与注释不可行（JSON 无注释），未触及键原样保留（键顺序按原文件）。
 * 解析失败抛错（不写坏文件）。
 */
export function mergeJsonConfig(source: string, changes: Record<string, unknown>): string {
  const parsed = source.trim() ? JSON.parse(source) as Record<string, unknown> : {}
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config root is not a JSON object')
  }
  for (const [key, value] of Object.entries(changes)) {
    parsed[key] = value
  }
  return JSON.stringify(parsed, null, 2) + '\n'
}

/** TOML 值序列化（string / number / boolean / 数组 / 内联表递归） */
export function tomlValue(value: unknown, indent = 0): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return '[' + value.map(v => tomlValue(v)).join(', ') + ']'
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    const pad = ' '.repeat(indent + 2)
    const body = entries.map(([k, v]) => `${pad}${k} = ${tomlValue(v, indent + 2)}`).join('\n')
    return '{\n' + body + '\n' + ' '.repeat(indent) + '}'
  }
  throw new Error(`unsupported TOML value: ${String(value)}`)
}

/**
 * TOML 顶层键替换：只重写被 changes 命中的「顶层 key = ...」行或
 * 「[table]」整表；其余行（含注释、空行、嵌套表内容）原样保留。
 * - changes 的 value 为纯对象 → 替换整个 [table] 段（表体全部重写，保留段内独立注释行）
 * - value 为标量/数组 → 替换顶层 `key = value` 行（不存在则插到首个表头前或文件尾）
 * 状态全部局部，函数可重入（单测覆盖）。
 */
export function mergeTomlConfig(source: string, changes: Record<string, unknown>): string {
  const lines = source.split('\n')
  // 第一遍：定位每个顶层表的 [name] 头与表体范围，以及顶层标量 key 行
  const tableSpan = new Map<string, { header: number; end: number }>()
  const topLevelLine = new Map<string, number>()
  let currentName: string | null = null
  let currentHeader = -1
  const closeTable = (endExclusive: number): void => {
    if (currentName !== null && currentHeader >= 0) {
      tableSpan.set(currentName, { header: currentHeader, end: endExclusive })
    }
  }
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    const headerMatch = /^\[\[?([^\]#]+)\]?\]/.exec(trimmed)
    if (headerMatch) {
      closeTable(i - 1)
      currentName = headerMatch[1].trim().replace(/^["']|["']$/g, '')
      currentHeader = i
    } else if (currentName === null && /^[A-Za-z0-9_-]+\s*=/.test(trimmed)) {
      const key = trimmed.split('=')[0].trim().replace(/^["']|["']$/g, '')
      if (!topLevelLine.has(key)) topLevelLine.set(key, i)
    }
  })
  closeTable(lines.length)
  const lineToTable = (i: number): string | null => {
    for (const [name, span] of tableSpan) {
      if (i > span.header && i <= span.end) return name
    }
    return null
  }

  const tableKeys = new Set(
    Object.keys(changes).filter(k => changes[k] !== null && typeof changes[k] === 'object' && !Array.isArray(changes[k]))
  )
  const scalarKeys = new Set(Object.keys(changes).filter(k => !tableKeys.has(k)))
  /**
   * changes 的表键 → 文件内表名的映射：
   * - 完全同名（changes.model_providers 替换 [model_providers]）
   * - 点路径前缀（changes.model_providers = { custom: {...} } 替换 [model_providers.custom]，
   *   对齐 cc-switch codex 编辑器语义：嵌套一层即对应 `[<key>.<subkey>]` 子表）
   */
  const tableTargets = new Map<string, { header: string; body: Record<string, unknown> }>()
  for (const key of tableKeys) {
    const value = changes[key] as Record<string, unknown>
    const nested = [...tableSpan.keys()].filter(name => name === key || name.startsWith(key + '.'))
    if (nested.length > 0) {
      // 文件内有 [key] 或 [key.*]：逐个子表用其「文件内表名对应的子对象」替换
      for (const name of nested) {
        let body: unknown = value
        if (name !== key) {
          for (const seg of name.slice(key.length + 1).split('.')) {
            body = (body as Record<string, unknown>)?.[seg]
          }
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) continue
        tableTargets.set(name, { header: name, body: body as Record<string, unknown> })
      }
    } else {
      // 文件内没有该表：若 changes 值是「单层嵌套对象」且值均为对象 → 拆成 [key.sub] 子表；否则整表 [key]
      const entries = Object.entries(value)
      const allObjects = entries.length > 0 && entries.every(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v))
      if (allObjects && entries.every(([k]) => /^[A-Za-z0-9_-]+$/.test(k))) {
        for (const [sub, body] of entries) tableTargets.set(`${key}.${sub}`, { header: `${key}.${sub}`, body: body as Record<string, unknown> })
      } else {
        tableTargets.set(key, { header: key, body: value })
      }
    }
  }
  const emittedTables = new Set<string>()
  const emittedScalars = new Set<string>()
  const keepLine = (i: number, line: string): string | null => {
    const trimmed = line.trim()
    // 顶层表体外的顶层标量行
    const ownerTable = lineToTable(i)
    const headerMatch = /^\[\[?([^\]#]+)\]?\]/.exec(trimmed)
    if (headerMatch) {
      const name = headerMatch[1].trim().replace(/^["']|["']$/g, '')
      // 被替换的表：输出新表头 + 新表体；原表体行在后续按行处理时丢弃
      const target = tableTargets.get(name)
      if (target && !emittedTables.has(name)) {
        emittedTables.add(name)
        const out: string[] = [`[${name}]`]
        for (const [k, v] of Object.entries(target.body)) out.push(`${k} = ${tomlValue(v)}`)
        return out.join('\n')
      }
      return line
    }
    if (ownerTable === null && /^[A-Za-z0-9_-]+\s*=/.test(trimmed)) {
      const key = trimmed.split('=')[0].trim().replace(/^["']|["']$/g, '')
      if (scalarKeys.has(key)) {
        if (!emittedScalars.has(key)) {
          emittedScalars.add(key)
          return `${key} = ${tomlValue(changes[key])}`
        }
        return null // 重复定义行丢弃
      }
      return line
    }
    if (ownerTable !== null && tableTargets.has(ownerTable) && trimmed !== '' && !trimmed.startsWith('#')) {
      // 被替换表的原始表体（非注释/非空行）丢弃
      return null
    }
    return line
  }

  const output: string[] = []
  lines.forEach((line, i) => {
    const replacement = keepLine(i, line)
    if (replacement === null) return
    // 多行替换（新表体）按换行拆回
    for (const part of replacement.split('\n')) output.push(part)
  })
  // 原文件没有的顶层标量：插到首个表头前（TOML 顶层键必须在任何表头之前），无表头则尾加
  const firstHeader = [...tableSpan.values()].map(s => s.header).sort((a, b) => a - b)[0]
  for (const key of scalarKeys) {
    if (emittedScalars.has(key) || topLevelLine.has(key)) continue
    const rendered = `${key} = ${tomlValue(changes[key])}`
    if (firstHeader !== undefined) output.splice(firstHeader, 0, rendered)
    else output.push(rendered)
    emittedScalars.add(key)
  }
  // 原文件没有的表：尾加
  for (const [name, target] of tableTargets) {
    if (emittedTables.has(name)) continue
    if (output.length && output[output.length - 1].trim() !== '') output.push('')
    output.push(`[${name}]`)
    for (const [k, v] of Object.entries(target.body)) output.push(`${k} = ${tomlValue(v)}`)
    emittedTables.add(name)
  }
  return output.join('\n')
}

/**
 * YAML 顶层键替换（保守行式合并，用于 hermes config.yaml）：
 * 只替换顶层的 `key:` / `key: value` 行；嵌套内容非目标键时原样保留。
 * 目标键为对象且原为块映射时，缩进 2 空格重写子键；原键不存在则尾加。
 */
export function mergeYamlConfig(source: string, changes: Record<string, unknown>): string {
  const lines = source.split('\n')
  const keys = Object.keys(changes)
  const emitted = new Set<string>()
  const output: string[] = []
  let skippingIndent = -1
  for (const line of lines) {
    const trimmed = line.trim()
    if (skippingIndent >= 0) {
      // 跳过被替换键的整个嵌套块（缩进 > skippingIndent 或同缩进列表项）
      if (trimmed !== '' && line.length - line.search(/\S|$/) > 0) {
        const indent = line.search(/\S/)
        if (indent > skippingIndent || indent === skippingIndent && /^-\s/.test(trimmed)) continue
      }
      skippingIndent = -1
    }
    const m = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(trimmed)
    const indent = line.search(/\S/)
    if (m && indent === 0 && keys.includes(m[1])) {
      const key = m[1]
      const value = changes[key]
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        output.push(`${key}:`)
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          output.push(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        }
      } else {
        output.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      }
      emitted.add(key)
      // 后续该键的嵌套行（若有）在下一轮被 skippingIndent 过滤
      skippingIndent = 0
      continue
    }
    output.push(line)
  }
  for (const key of keys) {
    if (emitted.has(key)) continue
    const value = changes[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      output.push(`${key}:`)
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        output.push(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      }
    } else {
      output.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    }
  }
  return output.join('\n')
}

// —— 快照（写前自动备份，保留最近 BACKUP_KEEP 份）——

const BACKUP_KEEP = 20

function backupRoot(): string {
  return join(getAppPathsRoot(), 'agent-config-backups')
}

function backupDir(app: string): string {
  return join(backupRoot(), app)
}

function listBackupIds(app: string): string[] {
  const dir = backupDir(app)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T[\d.]-?\d*$/.test(e.name) === false) // 任意目录名都接受
      .map(e => e.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** 按 changes 归属文件：写默认落 adapter 的主配置文件（configPaths[0]）；codex auth 用 "auth.json" 子键指定 */
function resolveTarget(adapter: AgentAdapter, fileHint?: string): { path: string; format: AgentConfigFormat } {
  if (!fileHint) return { path: adapter.configPaths[0], format: adapter.formats[0] }
  const hit = adapter.configPaths.findIndex(p => p.endsWith(fileHint))
  if (hit >= 0) return { path: adapter.configPaths[hit], format: adapter.formats[hit] }
  throw new Error(`file "${fileHint}" not in whitelist for ${adapter.app}`)
}

export interface AgentAppStatus {
  app: string
  name: string
  configPaths: string[]
  /** 主配置文件存在（视为已安装/已初始化） */
  installed: boolean
  /** 适配器活跃检测（如 codex auth 有登录材料） */
  active: boolean
}

export function agentApps(): AgentAppStatus[] {
  return AGENT_ADAPTERS.map(adapter => ({
    app: adapter.app,
    name: adapter.name,
    configPaths: adapter.configPaths,
    installed: existsSync(adapter.configPaths[0]),
    active: adapter.isActive?.() ?? existsSync(adapter.configPaths[0])
  }))
}

export interface AgentFileSnapshot {
  path: string
  content: string
  parsed: unknown
  exists: boolean
}

export interface AgentReadResult {
  app: string
  files: AgentFileSnapshot[]
  active: boolean
  readAt: number
}

export function agentRead(_pluginId: string, app: string): AgentReadResult {
  const adapter = findAdapter(app)
  const files: AgentFileSnapshot[] = adapter.configPaths.map((path, i) => {
    if (!existsSync(path)) return { path, content: '', parsed: null, exists: false }
    const content = readFileSync(path, 'utf-8')
    let parsed: unknown = null
    try {
      if (adapter.formats[i] === 'json') parsed = JSON.parse(content)
      // toml / yaml 只回传原文（解析器未引入依赖；插件侧自行处理）
    } catch (err) {
      logWarn('agent-config', `parse failed for ${path}: ${(err as Error).message}`)
    }
    return { path, content, parsed, exists: true }
  })
  return { app: adapter.app, files, active: adapter.isActive?.() ?? false, readAt: Date.now() }
}

export interface AgentWriteInputPayload {
  app: string
  /** 顶层键 → 新值；`$file` 特殊键指定目标文件名（如 codex 的 "auth.json"） */
  changes: Record<string, unknown>
  /** 危险写确认（写系统将落盘用户配置，插件 UI 必须先弹确认） */
  confirmed?: boolean
}

export interface AgentWriteResultPayload {
  ok: boolean
  app: string
  written: string[]
  backupId: string
}

export function agentWrite(_pluginId: string, input: AgentWriteInputPayload): AgentWriteResultPayload {
  const adapter = findAdapter(String(input?.app ?? ''))
  if (!input?.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)) {
    throw new Error('changes required (top-level key map)')
  }
  if (input.confirmed !== true) throw new Error('请先确认写入配置')
  const { $file: fileHint, ...changes } = input.changes as Record<string, unknown> & { $file?: string }
  const target = resolveTarget(adapter, typeof fileHint === 'string' ? fileHint : undefined)
  if (Object.keys(changes).length === 0) throw new Error('changes is empty (nothing to merge)')
  const source = existsSync(target.path) ? readFileSync(target.path, 'utf-8') : ''
  const merged =
    target.format === 'json'
      ? mergeJsonConfig(source, changes)
      : target.format === 'toml'
        ? mergeTomlConfig(source, changes)
        : mergeYamlConfig(source, changes)
  // 写前快照（目录 id：ISO 时间戳，冒号替换为点，跨平台安全）
  const backupId = new Date().toISOString().replace(/[:]/g, '.')
  const dir = join(backupDir(adapter.app), backupId)
  mkdirSync(dir, { recursive: true })
  for (const path of adapter.configPaths) {
    if (!existsSync(path)) continue
    try {
      const name = path === adapter.configPaths[0] ? 'main' + extOf(path) : basenameOf(path)
      writeFileSync(join(dir, name), readFileSync(path))
    } catch (err) {
      logWarn('agent-config', `backup failed for ${path}: ${(err as Error).message}`)
    }
  }
  // 落盘（先确保父目录存在——首写场景）
  mkdirSync(dirnameOf(target.path), { recursive: true })
  writeFileSync(target.path, merged, 'utf-8')
  pruneBackups(adapter.app)
  return { ok: true, app: adapter.app, written: [target.path], backupId }
}

function extOf(path: string): string {
  const m = /\.[a-z]+$/.exec(path)
  return m ? m[0] : ''
}
function basenameOf(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || 'file'
}
function dirnameOf(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/') || '/'
}

/** 只保留最近 BACKUP_KEEP 份快照（按目录名时间倒序） */
function pruneBackups(app: string): void {
  const ids = listBackupIds(app)
  for (const stale of ids.slice(BACKUP_KEEP)) {
    try { rmSync(join(backupDir(app), stale), { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

export interface AgentBackupEntry {
  id: string
  app: string
  createdAt: number
  files: string[]
}

export function agentBackups(_pluginId: string, app: string): AgentBackupEntry[] {
  const adapter = findAdapter(app)
  const dir = backupDir(adapter.app)
  const ids = listBackupIds(adapter.app)
  return ids.map(id => {
    let files: string[] = []
    try { files = readdirSync(join(dir, id)) } catch { /* 忽略 */ }
    return { id, app: adapter.app, createdAt: Date.parse(id.replace(/\./g, ':').replace(/(\d{2}:\d{2}:\d{2}):/, '$1.')) || 0, files }
  })
}

export function agentRestore(_pluginId: string, input: { app: string; id: string }): boolean {
  const adapter = findAdapter(String(input?.app ?? ''))
  const id = String(input?.id ?? '')
  if (!/^[\dT.Z+-]+$/.test(id)) throw new Error('invalid backup id')
  const dir = join(backupDir(adapter.app), id)
  if (!existsSync(dir)) throw new Error(`backup not found: ${id}`)
  let restored = 0
  // 快照文件名：main.<ext>（主配置）或原 basename（次文件）
  for (const name of readdirSync(dir)) {
    const target =
      name.startsWith('main.')
        ? adapter.configPaths.find(p => p.endsWith(name.slice(4)))
        : adapter.configPaths.find(p => p.endsWith('/' + name))
    if (!target) continue
    // 恢复前对当前状态做一次新快照（防恢复本身失误）
    const safetyId = new Date().toISOString().replace(/[:]/g, '.')
    const safetyDir = join(backupDir(adapter.app), safetyId)
    mkdirSync(safetyDir, { recursive: true })
    if (existsSync(target)) {
      try { writeFileSync(join(safetyDir, name), readFileSync(target)) } catch { /* 忽略 */ }
    }
    writeFileSync(target, readFileSync(join(dir, name)))
    restored++
  }
  if (restored === 0) throw new Error('backup contains no whitelisted files')
  pruneBackups(adapter.app)
  return true
}

// —— 会话日志只读通道（agent.sessions.list / agent.sessions.read）——
// 语义移植自 cc-switch session_usage_*（Claude ~/.claude/projects/**/*.jsonl、
// Codex ~/.codex/sessions/**、Gemini ~/.gemini/tmp/**、OpenCode/ Pi / OpenClaw 各自
// 会话目录）：只列出与读取白名单目录下的 jsonl/json 文件，不提供任何写/删能力。

/** 单文件会话条目上限（防止超大目录把返回撑爆 IPC） */
const SESSIONS_LIST_MAX_FILES = 2000
/** 单次 list 目录扫描的 fs.stat 数量上限（超大目录按 mtime 排序后截断） */
const SESSIONS_READ_MAX_BYTES = 512 * 1024
/** sessions.read 单行长度上限：超过截断该行并标记 truncated（防单行超大 base64 撑爆渲染层） */
const SESSIONS_READ_MAX_LINE_BYTES = 256 * 1024

export interface AgentSessionFile {
  /** 相对 sessionDirs 根的路径（读回传用 file 参数） */
  file: string
  /** 绝对路径（仅展示） */
  path: string
  bytes: number
  /** mtime 毫秒 */
  modifiedAt: number
  /** 目录段推断的项目路径（claude-code 项目目录名，其余为空） */
  project?: string
}

export interface AgentSessionsListResult {
  app: string
  root: string
  files: AgentSessionFile[]
  /** 截断（超出上限）时为 true */
  truncated: boolean
}

/** 规范化相对路径：拒绝绝对路径 / ../ 逃逸 / 空段 */
function safeRelPath(rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return null
  const segs = rel.split('/').filter(s => s.length > 0)
  if (segs.length === 0) return null
  if (segs.some(s => s === '.' || s === '..')) return null
  return segs.join('/')
}

/** 深度优先收集目录下 .jsonl/.json 文件（跟随白名单根；限制总深度与数量） */
function collectSessionFiles(rootDir: string, baseRel: string, out: AgentSessionFile[], budget: { count: number }): void {
  if (budget.count <= 0 || out.length >= SESSIONS_LIST_MAX_FILES) return
  let entries: Dirent[]
  try {
    entries = readdirSync(rootDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= SESSIONS_LIST_MAX_FILES) return
    const abs = join(rootDir, entry.name)
    if (entry.isDirectory()) {
      // 会话目录常规深度：projects/<proj>/<sid>/subagents/workflows/wf_*（≤6 层）
      if (baseRel.split('/').length >= 7) continue
      collectSessionFiles(abs, baseRel ? `${baseRel}/${entry.name}` : entry.name, out, budget)
    } else if (entry.isFile() && /\.jsonl?$/.test(entry.name)) {
      budget.count--
      try {
        const st = statSync(abs)
        out.push({
          file: baseRel ? `${baseRel}/${entry.name}` : entry.name,
          path: abs,
          bytes: st.size,
          modifiedAt: Math.round(st.mtimeMs),
          project: projectOf(baseRel ? `${baseRel}/${entry.name}` : entry.name)
        })
      } catch {
        /* 单文件 stat 失败跳过 */
      }
    }
  }
}

/** claude-code：projects/<encoded-project> 的第二段解码出项目路径（-m-- 编码与 cc-switch 对齐，尽力而为） */
function projectOf(rel: string): string | undefined {
  const segs = rel.split('/')
  if (segs[0] !== 'projects' || segs.length < 2) return undefined
  try {
    return segs[1].replace(/-m--/g, '@').replace(/-s--/g, '/').replace(/-d--/g, '.')
  } catch {
    return undefined
  }
}

export function agentSessionsList(_pluginId: string, app: string): AgentSessionsListResult[] {
  const adapter = findAdapter(String(app ?? ''))
  if (!adapter.sessionDirs || adapter.sessionDirs.length === 0) {
    throw new Error(`app "${adapter.app}" has no session directories`)
  }
  const results: AgentSessionsListResult[] = []
  for (const dir of adapter.sessionDirs) {
    if (!existsSync(dir)) continue
    const files: AgentSessionFile[] = []
    collectSessionFiles(dir, '', files, { count: 5000 })
    files.sort((a, b) => b.modifiedAt - a.modifiedAt)
    const truncated = files.length >= SESSIONS_LIST_MAX_FILES
    results.push({
      app: adapter.app,
      root: dir,
      files: files.slice(0, SESSIONS_LIST_MAX_FILES),
      truncated
    })
  }
  return results
}

export interface AgentSessionLine {
  /** 行号（1 起） */
  n: number
  /** 解析后的 JSON 对象；解析失败为 null */
  json: unknown
  /** 原始行文本（超长截断） */
  raw: string
  truncated: boolean
}

export interface AgentSessionsReadResult {
  app: string
  file: string
  path: string
  bytes: number
  /** 实际读取字节数（≤ maxBytes） */
  readBytes: number
  truncated: boolean
  lines: AgentSessionLine[]
}

export function agentSessionsRead(
  _pluginId: string,
  input: { app: string; file: string; maxBytes?: number }
): AgentSessionsReadResult {
  const adapter = findAdapter(String(input?.app ?? ''))
  const rel = safeRelPath(String(input?.file ?? ''))
  if (!rel) throw new Error('file must be a safe relative path')
  if (adapter.sessionMatch && !adapter.sessionMatch(rel)) {
    throw new Error(`file "${rel}" rejected by session whitelist for ${adapter.app}`)
  }
  // 在白名单根目录下定位（多根时按存在命中；经 normalize 防符号前缀逃逸）
  let abs: string | null = null
  let root = ''
  for (const dir of adapter.sessionDirs ?? []) {
    const candidate = join(dir, rel)
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      abs = candidate
      root = dir
      break
    }
  }
  if (!abs) throw new Error(`session file not found: ${rel}`)
  const maxBytes = Math.min(Math.max(Number(input?.maxBytes) || SESSIONS_READ_MAX_BYTES, 4 * 1024), SESSIONS_READ_MAX_BYTES)
  const st = statSync(abs)
  const handle = openReadHandle(abs)
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = readHandle(handle, buffer)
    const text = buffer.subarray(0, bytesRead).toString('utf-8')
    // 截到最后一行完整行（尾段半行丢弃，truncated 标记由字节判断）
    const lastNewline = text.lastIndexOf('\n')
    const body = lastNewline >= 0 ? text.slice(0, lastNewline) : text
    const lines: AgentSessionLine[] = []
    const parts = body.length > 0 ? body.split('\n') : []
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i]
      if (raw.trim().length === 0) continue
      let json: unknown = null
      try {
        json = JSON.parse(raw)
      } catch {
        /* 坏行保留原文 */
      }
      const truncatedLine = Buffer.byteLength(raw, 'utf-8') > SESSIONS_READ_MAX_LINE_BYTES
      lines.push({
        n: i + 1,
        json,
        raw: truncatedLine ? raw.slice(0, SESSIONS_READ_MAX_LINE_BYTES) : raw,
        truncated: truncatedLine
      })
    }
    return {
      app: adapter.app,
      file: rel,
      path: abs,
      bytes: st.size,
      readBytes: bytesRead,
      truncated: bytesRead < st.size,
      lines
    }
  } finally {
    closeHandle(handle)
  }
}

function openReadHandle(path: string): number {
  return openSync(path, 'r')
}
function readHandle(fd: number, buffer: Buffer): { bytesRead: number } {
  const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
  return { bytesRead }
}
function closeHandle(fd: number): void {
  try { closeSync(fd) } catch { /* 已关闭 */ }
}
