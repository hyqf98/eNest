/**
 * DevConsole — 开发态插件加载
 * 职责：从本地目录加载开发中的插件（跳过安装流程），注册到 PluginRegistry 的 dev 通道。
 * 被 shellHandlers 的 ShellLoadDevPlugin 通道调用。
 * 关键依赖：PluginInstaller（manifest 校验）、PluginRegistry（dev 插件注册）。
 */
import { dialog } from 'electron'
import { installFromDirectory } from '../plugin/PluginInstaller'
import { pluginRegistry } from '../plugin/PluginRegistry'
import type { PluginSummary } from '@shared/types/plugin'
import { resolvePluginUi } from '@shared/types/plugin'

/** 从指定目录加载开发态插件，注册到 PluginRegistry 的 dev 通道（不复制到 userData） */
export async function loadDevPlugin(dirPath: string): Promise<PluginSummary> {
  const manifest = await installFromDirectory(dirPath)
  const summary: PluginSummary = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? '',
    author: manifest.author ?? '',
    category: '开发',
    installs: 'dev',
    color: '#f5a524',
    glyph: '⌥',
    permissions: manifest.permissions ?? [],
    installed: true,
    rootPath: dirPath,
    devUrl: manifest.development?.main,
    ui: resolvePluginUi(manifest.ui)
  }
  pluginRegistry.addDevPlugin(summary, manifest)
  return summary
}

/** 可选路径：未传时弹出系统目录选择对话框，用户取消返回 null */
export async function pickAndLoadDevPlugin(dirPath?: string): Promise<PluginSummary | null> {
  let dir = dirPath
  if (!dir) {
    const result = await dialog.showOpenDialog({
      title: '选择插件目录',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    dir = result.filePaths[0]
  }
  return loadDevPlugin(dir)
}
