/**
 * dshProfileService — DSH profile 可视化管理与会话/备份的宿主侧实现。
 * - profiles：解析 $DSH_HOME/profiles/<name>/{package.json(dsh.profile.bundles),
 *   cordis.patch.yml} 供设置台可视化；创建（模板复制，失败回落 --from-default-profile）、
 *   删除（默认先备份）、目录级备份/恢复。
 * - 备份：快照式目录复制（排除 node_modules），meta.json 记录元数据；profile 与
 *   home（全量，含 .credentials.yaml/storages/sessions）两级。
 * - 会话扫描：发现 DSH_HOME 内 session*.jsonl[.zstd]（每目录取最高 generation），
 *   解析末段事件供小窗进度渲染。
 * 关键依赖：node:fs、pathsService、dshRuntimeStore。
 */
import {
  closeSync,
  cpSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync
} from 'node:fs'
import { basename, join } from 'node:path'
import * as zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { dshDataDirs, resolveRuntime } from '@main/dsh/dshRuntimeStore'
import type {
  DshBackupEntry,
  DshProfileInfo,
  DshSessionEventDump,
  DshSessionHeader
} from '@shared/types/dsh-workbench'

/** dsh 内置模板 profile 名 */
export const DSH_BUILTIN_PROFILES = ['web', 'headless', 'sdk', 'sdk-minimal', 'acp'] as const
/** Electron 保留 profile 名 */
const RESERVED_PROFILE = 'desktop'
/** 备份排除项（可再生成 / 体积巨大） */
const BACKUP_EXCLUDE = ['node_modules', '.pnpm', '.DS_Store', '*.lock']
/** 会话标题抽取读取上限 */
const SESSION_PEEK_BYTES = 512 * 1024

/** Node 22.15+ 实验性 zstd 同步解压；不可用时跳过压缩会话 */
const zstdDecompressSyncFn = (zlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync

function profilesDir(): string {
  return join(dshDataDirs().dshHome, 'profiles')
}

function safeProfileName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`非法 profile 名: ${name}`)
  if (name === RESERVED_PROFILE) throw new Error('profile "desktop" 为保留名')
  if (name.length > 64) throw new Error('profile 名过长（≤64）')
  return name
}

// —— profiles ——

export function listProfiles(): DshProfileInfo[] {
  const dir = profilesDir()
  if (!existsSync(dir)) return []
  const result: DshProfileInfo[] = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    const root = join(dir, name.name)
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        dsh?: { profile?: { bundles?: unknown } }
        dependencies?: Record<string, string>
      }
      const bundles = Array.isArray(pkg.dsh?.profile?.bundles)
        ? pkg.dsh.profile!.bundles!.map(String)
        : []
      const plugins = pkg.dependencies
        ? Object.keys(pkg.dependencies).filter(k => k !== 'dsh-bundles' && !k.startsWith('@deepseek-ai/dsh-'))
        : []
      let patchLines = 0
      try {
        patchLines = readFileSync(join(root, 'cordis.patch.yml'), 'utf8').split('\n').length
      } catch {
        /* 无补丁文件 */
      }
      result.push({
        name: name.name,
        builtin: (DSH_BUILTIN_PROFILES as readonly string[]).includes(name.name),
        reserved: name.name === RESERVED_PROFILE,
        bundles,
        patchLines,
        plugins,
        createdAt: statSync(root).mtimeMs
      })
    } catch {
      result.push({ name: name.name, builtin: false, bundles: [], patchLines: 0, plugins: [] })
    }
  }
  return result.sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? -1 : 1))
}

/** 目录复制（含过滤） */
function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, {
    recursive: true,
    filter: source => {
      const name = basename(source)
      return !BACKUP_EXCLUDE.some(pattern =>
        pattern.startsWith('*') ? name.endsWith(pattern.slice(1)) : name === pattern
      )
    }
  })
}

/** 目录体积（字节，含排除过滤同备份口径） */
function treeSize(root: string): number {
  let total = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (BACKUP_EXCLUDE.includes(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else {
        try {
          total += statSync(full).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(root, 0)
  return total
}

function runDshDetached(args: string[]): Promise<{ code: number | null; stderr: string }> {
  const resolved = resolveRuntime()
  if (!resolved.bin) return Promise.reject(new Error('dsh runtime 不可用'))
  const command = resolved.engine === 'node' ? resolved.bin : process.execPath
  const prefix = resolved.engine === 'node' ? [] : [resolved.bin]
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshDataDirs().dshHome },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stderr: stderr.slice(-2000) }))
  })
}

export async function createProfile(name: string, template: string): Promise<void> {
  safeProfileName(name)
  if (!DSH_BUILTIN_PROFILES.includes(template as (typeof DSH_BUILTIN_PROFILES)[number])) {
    throw new Error(`未知模板: ${template}`)
  }
  const dir = profilesDir()
  const target = join(dir, name)
  if (existsSync(target)) throw new Error(`profile 已存在: ${name}`)
  const templateDir = join(dir, template)
  if (existsSync(templateDir)) {
    copyTree(templateDir, target)
    return
  }
  // 模板未初始化（该 profile 从未启动过）→ 用 CLI 从出厂模板创建（--dump-config 即建即退）
  const result = await runDshDetached(['--profile', name, '--from-default-profile', template, '--dump-config'])
  if (result.code !== 0 || !existsSync(target)) {
    throw new Error(`创建 profile 失败: ${result.stderr || `exit ${result.code}`}`)
  }
}

export function deleteProfile(name: string, backupFirst = true): string | null {
  safeProfileName(name)
  const target = join(profilesDir(), name)
  if (!existsSync(target)) throw new Error(`profile 不存在: ${name}`)
  let backupId: string | null = null
  if (backupFirst) backupId = createBackup('profile', name)
  rmSync(target, { recursive: true, force: true })
  return backupId
}

// —— 备份（目录快照 + meta.json）——

function backupsRoot(): string {
  return dshDataDirs().backupDir
}

function readBackupMeta(backupId: string): DshBackupEntry | null {
  try {
    return JSON.parse(readFileSync(join(backupsRoot(), backupId, 'meta.json'), 'utf8')) as DshBackupEntry
  } catch {
    return null
  }
}

export function listBackups(): DshBackupEntry[] {
  const root = backupsRoot()
  if (!existsSync(root)) return []
  const entries: DshBackupEntry[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const meta = readBackupMeta(entry.name)
    if (meta) entries.push(meta)
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt)
}

export function createBackup(scope: 'profile' | 'home', label?: string, targetProfile?: string): string {
  const backupId = `${scope}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const dest = join(backupsRoot(), backupId)
  mkdirSync(dest, { recursive: true })
  const { dshHome } = dshDataDirs()
  let size = 0
  if (scope === 'profile') {
    const name = safeProfileName(String(targetProfile ?? ''))
    const src = join(dshHome, 'profiles', name)
    if (!existsSync(src)) {
      rmSync(dest, { recursive: true, force: true })
      throw new Error(`profile 不存在: ${name}`)
    }
    copyTree(src, join(dest, 'profile', name))
    size = treeSize(join(dest, 'profile'))
  } else {
    // home 全量：排除各 profile 的 node_modules（备份口径）
    copyTree(dshHome, join(dest, 'home'))
    size = treeSize(join(dest, 'home'))
  }
  const entry: DshBackupEntry = {
    backupId,
    scope,
    name: label,
    target: targetProfile,
    sizeBytes: size,
    createdAt: Date.now()
  }
  writeFileSync(join(dest, 'meta.json'), JSON.stringify(entry, null, 2))
  return backupId
}

export function restoreBackup(backupId: string): void {
  if (!/^[a-z]+-[a-z0-9-]+$/i.test(backupId)) throw new Error('非法 backupId')
  const meta = readBackupMeta(backupId)
  if (!meta) throw new Error(`备份不存在: ${backupId}`)
  const { dshHome } = dshDataDirs()
  if (meta.scope === 'profile') {
    const src = join(backupsRoot(), backupId, 'profile')
    const names = existsSync(src) ? readdirSync(src) : []
    for (const name of names) {
      const target = join(dshHome, 'profiles', name)
      rmSync(target, { recursive: true, force: true })
      copyTree(join(src, name), target)
    }
  } else {
    const src = join(backupsRoot(), backupId, 'home')
    if (!existsSync(src)) throw new Error('备份内容缺失')
    // 只清空可恢复面（profiles 配置/凭据/存储/会话），保留运行期无关文件由复制覆盖
    for (const name of ['profiles', 'storages', 'sessions'] as const) {
      const target = join(dshHome, name)
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    }
    for (const file of ['.credentials.yaml', '.anonymous-user-id']) {
      const target = join(dshHome, file)
      if (existsSync(target)) rmSync(target, { force: true })
    }
    copyTree(src, dshHome)
  }
}

export function deleteBackup(backupId: string): void {
  if (!/^[a-z]+-[a-z0-9-]+$/i.test(backupId)) throw new Error('非法 backupId')
  const dir = join(backupsRoot(), backupId)
  if (!existsSync(dir)) throw new Error(`备份不存在: ${backupId}`)
  rmSync(dir, { recursive: true, force: true })
}

// —— 会话持久化扫描 ——

interface SessionFile {
  sessionId: string
  dir: string
  file: string
  generation: number
  mtimeMs: number
  size: number
}

function findSessionFiles(root: string, depth: number, out: SessionFile[]): void {
  if (depth > 5) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  const byDir = new Map<string, SessionFile>()
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      // 会话目录：目录名即 sessionId 候选（包含 session*.jsonl）
      findSessionFiles(full, depth + 1, out)
    } else {
      const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(entry.name)
      if (!match) continue
      const sessionId = basename(root)
      const generation = match[1] ? Number(match[1]) : 0
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      const existing = byDir.get(root)
      const candidate: SessionFile = {
        sessionId,
        dir: root,
        file: full,
        generation,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      }
      if (!existing || generation > existing.generation) byDir.set(root, candidate)
    }
  }
  for (const value of byDir.values()) out.push(value)
}

function readSessionText(file: string, tailBytes: number): string | null {
  try {
    if (file.endsWith('.zstd')) {
      if (!zstdDecompressSyncFn) return null
      const buf = zstdDecompressSyncFn(readFileSync(file))
      const text = buf.toString('utf8')
      return text.length > tailBytes ? text.slice(-tailBytes) : text
    }
    const stat = statSync(file)
    const fd = openSync(file, 'r')
    try {
      const start = Math.max(0, stat.size - tailBytes)
      const length = stat.size - start
      const buf = Buffer.alloc(length)
      readSync(fd, buf, 0, length, start)
      return buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** 从事件文本提取标题（首个 user 消息文本）与最近活动摘要 */
function summarizeSession(text: string | null): { title?: string; lastActivity?: string } {
  if (!text) return {}
  let title: string | undefined
  let lastActivity: string | undefined
  try {
    const lines = text.split('\n').filter(Boolean)
    for (const line of lines) {
      let event: { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } }
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      const blocks = event.message?.content
      if (event.type === 'user/message' && Array.isArray(blocks)) {
        const firstText = blocks.find(b => b?.type === 'text' && typeof b.text === 'string')
        if (!title && firstText) title = firstText.text!.slice(0, 80)
      }
      if (typeof event.type === 'string') lastActivity = event.type
    }
  } catch {
    /* 解析尽力而为 */
  }
  return { title, lastActivity }
}

export function listSessions(limit = 50): DshSessionHeader[] {
  const { dshHome } = dshDataDirs()
  const files: SessionFile[] = []
  findSessionFiles(dshHome, 0, files)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const seen = new Set<string>()
  const result: DshSessionHeader[] = []
  for (const file of files) {
    if (seen.has(file.sessionId)) continue
    seen.add(file.sessionId)
    const summary = summarizeSession(readSessionText(file.file, SESSION_PEEK_BYTES))
    result.push({
      sessionId: file.sessionId,
      title: summary.title,
      workspace: undefined,
      updatedAt: file.mtimeMs,
      lastActivity: summary.lastActivity
    })
    if (result.length >= Math.max(1, Math.min(200, limit))) break
  }
  return result
}

export function readSessionEvents(sessionId: string, maxEvents = 200): DshSessionEventDump {
  // sessionId 即目录名；拒绝穿越
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) throw new Error('非法 sessionId')
  const { dshHome } = dshDataDirs()
  const files: SessionFile[] = []
  findSessionFiles(dshHome, 0, files)
  const target = files.find(f => f.sessionId === sessionId)
  if (!target) throw new Error(`会话不存在: ${sessionId}`)
  const text = readSessionText(target.file, 4 * 1024 * 1024)
  const events: Array<Record<string, unknown>> = []
  if (text) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        /* 跳过残行 */
      }
    }
  }
  return { sessionId, events: events.slice(-Math.max(10, Math.min(1000, maxEvents))) }
}

/** 当前 relative 布局探测（诊断用）：DSH_HOME 相对路径树（≤2 层） */
export function diagnoseHome(): string[] {
  const { dshHome } = dshDataDirs()
  const lines: string[] = [dshHome]
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.slice(0, 40)) {
      lines.push(`${'  '.repeat(depth + 1)}${entry.name}${entry.isDirectory() ? '/' : ''}`)
      if (entry.isDirectory() && depth < 1) walk(join(dir, entry.name), depth + 1)
    }
  }
  walk(dshHome, 0)
  return lines
}
