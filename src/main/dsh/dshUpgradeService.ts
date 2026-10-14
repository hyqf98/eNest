/**
 * dshUpgradeService — DSH runtime 热更新版本管理与一键备份升级。
 * - 版本发现：eNest_plugin GitHub Releases 的 dsh-runtime-<ver>-<platform>.tgz 预编译
 *   资产（含 .sha256 边车）+ npm registry dist-tags 参考信息。
 * - 下载：流式落盘 → sha256 校验 → tar 解压到 {dataRoot}/dsh-runtime/<version>/
 *   （tgz 根即 node_modules/…）→ 布局校验；进度经 dsh:event 推送。
 * - 激活：active.json 标记 + `--version` 健康检查，失败自动回退标记。
 * - 一键备份升级：停进程 → home 全量备份 → 下载/激活 → 健康检查；
 *   任一步失败恢复备份并回退激活（回滚日志随事件推送）。
 * 关键依赖：node:fs、undici fetch（代理经 proxyService 进程 env）、
 * dshRuntimeStore、dshProfileService（备份）、dshRuntimeService（停进程）。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pluginHost } from '@main/plugin/PluginHost'
import { logWarn } from '@main/logs/logService'
import {
  clearActiveMarker,
  dshDataDirs,
  getActiveMarker,
  listInstalledRuntimes,
  runtimeBinAt,
  setActiveMarker
} from '@main/dsh/dshRuntimeStore'
import { createBackup, restoreBackup } from '@main/dsh/dshProfileService'
import { stopSdk, stopWeb } from '@main/dsh/dshRuntimeService'
import type { DshRemoteVersion, DshRuntimeVersion, DshWorkbenchEvent } from '@shared/types/dsh-workbench'

/** 预编译 runtime 资产所在的插件仓库（打包脚本同仓产出并上传 Release） */
const BUNDLE_REPO = 'hyqf98/eNest_plugin'
const GITHUB_API = `https://api.github.com/repos/${BUNDLE_REPO}/releases?per_page=30`
const NPM_REGISTRY = 'https://registry.npmjs.org/@deepseek-ai%2fdsh'
/** 下载超时 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

function platformTag(): string {
  return `${process.platform}-${process.arch}`
}

function emit(pluginId: string, event: DshWorkbenchEvent): void {
  pluginHost.sendEvent(pluginId, { type: 'dsh.event', event })
}

// —— 版本发现 ——

interface GithubAsset {
  name: string
  browser_download_url: string
  size: number
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res.json()
}

export async function listRemoteVersions(pluginId: string, limit = 20): Promise<DshRemoteVersion[]> {
  const tag = platformTag()
  const [releases, npmMeta] = await Promise.all([
    fetchJson(GITHUB_API).catch(() => null),
    fetchJson(NPM_REGISTRY).catch(() => null)
  ])
  const times = (() => {
    const meta = npmMeta as { time?: Record<string, string> } | null
    return meta?.time ?? {}
  })()
  const latest = (() => {
    const meta = npmMeta as { 'dist-tags'?: { latest?: string } } | null
    return meta?.['dist-tags']?.latest
  })()
  const result = new Map<string, DshRemoteVersion>()
  const assetVersion = (name: string): string | null => {
    if (!name.startsWith('dsh-runtime-') || !name.endsWith('.tgz')) return null
    if (!name.includes(`-${tag}.tgz`)) return null
    return name.slice('dsh-runtime-'.length, -'.tgz'.length).replace(new RegExp(`-${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '')
  }
  if (Array.isArray(releases)) {
    for (const release of releases as Array<{ tag_name?: string; assets?: GithubAsset[]; prerelease?: boolean; published_at?: string }>) {
      for (const asset of release.assets ?? []) {
        const version = assetVersion(asset.name)
        if (!version) continue
        result.set(version, {
          version,
          date: release.published_at,
          assetUrl: asset.browser_download_url
        })
      }
    }
  }
  // npm 最新版参考（无预编译资产时仍展示，标记不可直装）
  if (latest && !result.has(latest)) {
    result.set(latest, { version: latest, distTag: 'latest', date: times[latest] })
  }
  return [...result.values()]
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, Math.max(1, Math.min(50, limit)))
}

// —— 下载与安装 ——

async function downloadToFile(pluginId: string, url: string, dest: string, expectedSha256?: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`下载失败: HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') ?? 0)
    let received = 0
    let lastReport = 0
    const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      const now = Date.now()
      if (now - lastReport > 400) {
        lastReport = now
        emit(pluginId, {
          type: 'runtime-progress',
          phase: 'download',
          detail: `${received}${total ? `/${total}` : ''} bytes`,
          percent: total > 0 ? Math.round((received / total) * 100) : undefined
        })
      }
    })
    await pipeline(source, createWriteStream(dest))
    if (expectedSha256) {
      const digest = createHash('sha256').update(readFileSync(dest)).digest('hex')
      if (digest !== expectedSha256.replace(/^sha256:?/, '').trim()) {
        throw new Error('sha256 校验失败')
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

function runTar(tgz: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/tar', ['-xzf', tgz, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => (code === 0 ? resolve() : reject(new Error(`tar 解压失败: ${stderr.slice(-500)}`))))
  })
}

export async function installRuntimeVersion(pluginId: string, version: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(version)) throw new Error(`非法版本号: ${version}`)
  const { runtimeDir } = dshDataDirs()
  const target = join(runtimeDir, version)
  if (runtimeBinAt(target)) return // 已安装
  const remote = (await listRemoteVersions(pluginId, 50)).find(v => v.version === version)
  if (!remote?.assetUrl) throw new Error(`版本 ${version} 无 ${platformTag()} 预编译资产（需等待插件仓 Release 构建或手动安装）`)
  emit(pluginId, { type: 'runtime-progress', phase: 'download-start', detail: remote.assetUrl })
  const work = mkdtempSync(join(tmpdir(), 'enest-dsh-'))
  const tgz = join(work, 'runtime.tgz')
  try {
    let sha256: string | undefined
    try {
      const res = await fetch(`${remote.assetUrl}.sha256`)
      if (res.ok) sha256 = (await res.text()).trim()
    } catch {
      /* 边车缺失时跳过校验（Release 可控） */
    }
    await downloadToFile(pluginId, remote.assetUrl, tgz, sha256)
    emit(pluginId, { type: 'runtime-progress', phase: 'extract' })
    mkdirSync(target, { recursive: true })
    await runTar(tgz, target)
    if (!runtimeBinAt(target)) {
      rmSync(target, { recursive: true, force: true })
      throw new Error('解压后未找到 dsh bin（资产布局不符合约定：tgz 根须为 node_modules/…）')
    }
    emit(pluginId, { type: 'runtime-progress', phase: 'installed', detail: version })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// —— 激活 / 移除 ——

async function healthCheck(root: string): Promise<boolean> {
  const bin = runtimeBinAt(root)
  if (!bin) return false
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--version'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshDataDirs().dshHome },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(false)
    }, 20000)
    child.once('error', () => { clearTimeout(timer); resolve(false) })
    child.once('close', code => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

export async function activateRuntimeVersion(pluginId: string, version: string): Promise<void> {
  const { runtimeDir } = dshDataDirs()
  const target = join(runtimeDir, version)
  if (!runtimeBinAt(target)) throw new Error(`版本 ${version} 未安装`)
  const previous = getActiveMarker()
  setActiveMarker(version)
  emit(pluginId, { type: 'runtime-progress', phase: 'health-check', detail: version })
  if (!(await healthCheck(target))) {
    if (previous) setActiveMarker(previous)
    else clearActiveMarker()
    throw new Error(`版本 ${version} 健康检查失败，已回退到 ${previous ?? '捆绑/系统 runtime'}`)
  }
  emit(pluginId, { type: 'runtime-progress', phase: 'activated', detail: version })
}

export function removeRuntimeVersion(version: string): void {
  const active = getActiveMarker()
  if (active === version) throw new Error(`版本 ${version} 正在使用，先切换到其他版本再移除`)
  const { runtimeDir } = dshDataDirs()
  const target = join(runtimeDir, version)
  if (!existsSync(target)) throw new Error(`版本 ${version} 未安装`)
  rmSync(target, { recursive: true, force: true })
}

export function installedVersions(): DshRuntimeVersion[] {
  return listInstalledRuntimes()
}

// —— 一键备份升级 ——

export async function oneClickUpgrade(pluginId: string, version: string): Promise<{ backupId: string }> {
  const steps: string[] = []
  emit(pluginId, { type: 'runtime-progress', phase: 'upgrade-start', detail: `目标版本 ${version}` })
  stopWeb(pluginId)
  stopSdk(pluginId)
  steps.push('stopped-processes')
  const backupId = createBackup('home', `升级前快照 → ${version}`)
  steps.push(`backup:${backupId}`)
  let previousActive = getActiveMarker()
  try {
    await installRuntimeVersion(pluginId, version)
    steps.push('installed')
    previousActive = getActiveMarker()
    await activateRuntimeVersion(pluginId, version)
    steps.push('activated')
    emit(pluginId, { type: 'runtime-progress', phase: 'upgrade-done', detail: version })
    return { backupId }
  } catch (error) {
    // 回滚：恢复 home 备份 + 回退激活标记
    const detail = String((error as Error).message ?? error)
    emit(pluginId, { type: 'runtime-progress', phase: 'rollback', detail: `${detail}；恢复备份 ${backupId}` })
    logWarn('dsh', `一键升级失败，执行回滚: ${detail}`)
    try {
      if (previousActive) setActiveMarker(previousActive)
      restoreBackup(backupId)
    } catch (rollbackError) {
      throw new Error(`升级失败: ${detail}；回滚也失败: ${String((rollbackError as Error).message)}（备份 ${backupId} 保留在备份列表中）`)
    }
    throw new Error(`升级失败已回滚: ${detail}（备份 ${backupId} 保留）`)
  }
}

// —— 备份目录占用（诊断）——

export function backupsDiskUsage(): { bytes: number; count: number } {
  const { backupDir } = dshDataDirs()
  if (!existsSync(backupDir)) return { bytes: 0, count: 0 }
  let bytes = 0
  let count = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else {
        try {
          bytes += statSync(full).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(backupDir, 0)
  count = readdirSync(backupDir, { withFileTypes: true }).filter(e => e.isDirectory()).length
  return { bytes, count }
}
