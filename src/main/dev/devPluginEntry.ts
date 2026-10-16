import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { installFromDirectory } from '@main/plugin/PluginInstaller'
import { normalizePluginDevUrl } from '@shared/pluginContract'
import { ensureDevServer, matchesDevelopmentServer } from '@main/dev/devServerManager'
import { resolveDevCommandPlan } from '@main/dev/devCommandResolver'
import { runDevBuild } from '@main/dev/devBuildRunner'
import type { DevCommandPlan, DevPluginLoadOptions, PluginManifest } from '@shared/types/plugin'

export { matchesDevelopmentServer }

export interface ResolvedDevEntry {
  rootPath: string
  manifest: PluginManifest
  devSource: boolean
  devUrl?: string
  /** 当前选择的模式 */
  mode: 'dev' | 'prod'
  /** 解析出的启动/构建命令与产物目录（供 summary 标签与手动重建） */
  plan: DevCommandPlan
}

/** Explicit API overrides remain available; the developer UI uses automatic selection. */
export async function resolveDevPluginEntry(sourcePath: string, options: DevPluginLoadOptions = {}): Promise<ResolvedDevEntry> {
  const mode: 'dev' | 'prod' = options.mode ?? (options.preview === 'dist' ? 'prod' : 'dev')
  const manifest = await installFromDirectory(sourcePath, { source: true })
  const plan = resolveDevCommandPlan(sourcePath, manifest)
  const outputDir = join(sourcePath, plan.output)

  // prod＝打包后正式安装形态：产物缺失或版本落后时先执行解析出的构建命令，再按正式路径加载
  if (mode === 'prod') {
    let built = await readBuiltManifest(outputDir)
    if (!built || built.id !== manifest.id || built.version !== manifest.version) {
      await runDevBuild(manifest.id, sourcePath, plan)
      built = await readBuiltManifest(outputDir)
    }
    if (!built) throw new Error(`${manifest.name} 构建后仍未找到 ${plan.output}/plugin.json，请检查 enest.output 与构建脚本输出目录`)
    if (built.id !== manifest.id || built.version !== manifest.version) {
      throw new Error(`${manifest.name} 构建产物与源码版本不一致（${built.version} ≠ ${manifest.version}），请检查构建脚本输出目录`)
    }
    return { rootPath: outputDir, manifest: built, devSource: false, devUrl: undefined, mode, plan }
  }

  const declaredUrl = normalizePluginDevUrl(options.url ?? plan.devUrl)
  if (options.url !== undefined) return { rootPath: sourcePath, manifest, devSource: true, devUrl: declaredUrl, mode, plan }
  if (declaredUrl && await matchesDevelopmentServer(declaredUrl, manifest.id)) {
    return { rootPath: sourcePath, manifest, devSource: true, devUrl: declaredUrl, mode, plan }
  }
  // 开发服务未运行：先按解析出的命令自动拉起（无可用启动命令则跳过），就绪后走 devUrl + 框架 HMR；
  // 声明端口被占时 devServerManager 会换空闲端口，devUrl 用实际地址
  if (declaredUrl && options.autoStartServer && plan.start) {
    const startedUrl = await ensureDevServer(manifest.id, sourcePath, declaredUrl, plan.start)
    if (startedUrl) return { rootPath: sourcePath, manifest, devSource: true, devUrl: startedUrl, mode, plan }
  }
  if (declaredUrl && existsSync(join(outputDir, 'plugin.json'))) {
    const built = await readBuiltManifest(outputDir)
    if (built && (built.id !== manifest.id || built.version !== manifest.version)) {
      throw new Error(`${manifest.name} 的构建产物与源码版本不一致，请在插件目录运行 ${plan.build?.label ?? '构建命令'}`)
    }
    if (built) return { rootPath: outputDir, manifest: built, devSource: false, devUrl: undefined, mode, plan }
  }
  if (declaredUrl) {
    const startHint = plan.start ? `请启动该插件的开发服务（${plan.start.label}）` : 'package.json 未声明可用的启动脚本'
    const buildHint = plan.build ? `，或在插件目录运行 ${plan.build.label} 预生成产物` : ''
    throw new Error(`${manifest.name} 的开发服务未启动或端口属于其它项目；${startHint}${buildHint}`)
  }
  return { rootPath: sourcePath, manifest, devSource: true, devUrl: undefined, mode, plan }
}

async function readBuiltManifest(outputDir: string): Promise<PluginManifest | null> {
  if (!existsSync(join(outputDir, 'plugin.json'))) return null
  try {
    return await installFromDirectory(outputDir)
  } catch {
    return null
  }
}
