/**
 * devPluginEntry — 开发注册入口解析（唯一形态：开发态，自动识别）。
 * 无显式开关：有开发服务声明就连接/自动拉起（框架 HMR），连不上且有匹配的
 * 构建产物则按产物目录预览；否则走源码静态预览。识别结果（devKind）供控制台标签展示。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { installFromDirectory } from '@main/plugin/PluginInstaller'
import { normalizePluginDevUrl } from '@shared/pluginContract'
import { ensureDevServer, matchesDevelopmentServer } from '@main/dev/devServerManager'
import { resolveDevCommandPlan } from '@main/dev/devCommandResolver'
import type { DevCommandPlan, DevPluginKind, DevPluginLoadOptions, PluginManifest } from '@shared/types/plugin'

export { matchesDevelopmentServer }

export interface ResolvedDevEntry {
  rootPath: string
  manifest: PluginManifest
  devSource: boolean
  devUrl?: string
  /** 自动识别结果：开发服务形态的框架类型，或无服务声明时的 static */
  devKind: DevPluginKind
  /** 解析出的启动/构建命令与产物目录（供识别标签、离线提示与源码监听忽略产物目录） */
  plan: DevCommandPlan
}

/** Explicit API overrides remain available; the developer UI uses automatic selection. */
export async function resolveDevPluginEntry(sourcePath: string, options: DevPluginLoadOptions = {}): Promise<ResolvedDevEntry> {
  const manifest = await installFromDirectory(sourcePath, { source: true })
  const plan = resolveDevCommandPlan(sourcePath, manifest)
  const outputDir = join(sourcePath, plan.output)
  const declaredUrl = normalizePluginDevUrl(options.url ?? plan.devUrl)
  if (options.url !== undefined) {
    return { rootPath: sourcePath, manifest, devSource: true, devUrl: declaredUrl, devKind: declaredUrl ? plan.framework : 'static', plan }
  }
  if (declaredUrl && await matchesDevelopmentServer(declaredUrl, manifest.id)) {
    return { rootPath: sourcePath, manifest, devSource: true, devUrl: declaredUrl, devKind: plan.framework, plan }
  }
  // 开发服务未运行：先按解析出的命令自动拉起（无可用启动命令则跳过），就绪后走 devUrl + 框架 HMR；
  // 声明端口被占时 devServerManager 会换空闲端口，devUrl 用实际地址
  if (declaredUrl && options.autoStartServer && plan.start) {
    const startedUrl = await ensureDevServer(manifest.id, sourcePath, declaredUrl, plan.start)
    if (startedUrl) return { rootPath: sourcePath, manifest, devSource: true, devUrl: startedUrl, devKind: plan.framework, plan }
  }
  if (declaredUrl && existsSync(join(outputDir, 'plugin.json'))) {
    const built = await readBuiltManifest(outputDir)
    if (built && (built.id !== manifest.id || built.version !== manifest.version)) {
      throw new Error(`${manifest.name} 的构建产物与源码版本不一致，请在插件目录运行 ${plan.build?.label ?? '构建命令'}`)
    }
    // 服务离线但已有匹配产物：按产物目录预览（识别仍是框架类型，标签按运行态区分）
    if (built) return { rootPath: outputDir, manifest: built, devSource: false, devUrl: undefined, devKind: plan.framework, plan }
  }
  if (declaredUrl) {
    const startHint = plan.start ? `请启动该插件的开发服务（${plan.start.label}）` : 'package.json 未声明可用的启动脚本'
    const buildHint = plan.build ? `，或在插件目录运行 ${plan.build.label} 预生成产物` : ''
    throw new Error(`${manifest.name} 的开发服务未启动或端口属于其它项目；${startHint}${buildHint}`)
  }
  return { rootPath: sourcePath, manifest, devSource: true, devUrl: undefined, devKind: 'static', plan }
}

async function readBuiltManifest(outputDir: string): Promise<PluginManifest | null> {
  if (!existsSync(join(outputDir, 'plugin.json'))) return null
  try {
    return await installFromDirectory(outputDir)
  } catch {
    return null
  }
}
