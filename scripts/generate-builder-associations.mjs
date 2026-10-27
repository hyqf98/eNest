#!/usr/bin/env node
/**
 * generate-builder-associations — 「打开方式」打包配置同步工具
 *
 * 读取 build/open-with.json（与插件仓官方插件的 contributes.openWith 声明同步的快照），
 * 生成 electron-builder 需要的 protocols / fileAssociations 片段：
 *
 *   node scripts/generate-builder-associations.mjs print    # 打印生成的 YAML 片段
 *   node scripts/generate-builder-associations.mjs check    # 校验 electron-builder.yml 未与快照漂移（CI 用）
 *
 * 为什么不直接改 yml 生成产物：electron-builder 自动发现根目录 yml；本脚本以
 * 「快照 → 片段 → 校验」方式工作，改快照后手工把片段粘回 yml，check 防止两边漂移。
 * 第三方插件的新类型在 macOS 需随壳发版进入候选列表（Windows/Linux 运行时动态注册不受限）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const snapshotPath = join(root, 'build/open-with.json')
const builderPath = join(root, 'electron-builder.yml')

/** JSON 数组 → 两空格缩进 YAML 列表（值含特殊字符时加引号；本数据集仅中文与短横线，安全） */
function yamlList(items, indent = '  ') {
  return items.map(item => {
    const pairs = Object.entries(item).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n' + indent + '  ')
    return `${indent}- ${pairs}`
  }).join('\n')
}

function buildFragment() {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  const lines = ['# —— 由 scripts/generate-builder-associations.mjs 生成（源：build/open-with.json），请勿手改 ——']
  lines.push('# macOS: Info.plist CFBundleURLTypes / CFBundleDocumentTypes；Windows: NSIS 注册；Linux: .desktop MimeType')
  lines.push('protocols:')
  for (const p of snapshot.protocols) {
    lines.push(`  - name: ${JSON.stringify(p.name)}`)
    lines.push('    schemes:')
    for (const scheme of p.schemes) lines.push(`      - ${scheme}`)
  }
  lines.push('fileAssociations:')
  lines.push(yamlList(snapshot.fileAssociations))
  return { text: lines.join('\n') + '\n', snapshot }
}

const mode = process.argv[2] ?? 'print'
const { text } = buildFragment()

if (mode === 'print') {
  process.stdout.write(text)
  process.exit(0)
}
if (mode === 'check') {
  const yml = readFileSync(builderPath, 'utf8')
  if (!yml.includes(text.trim())) {
    console.error('✗ electron-builder.yml 的 associations 块与 build/open-with.json 漂移；运行 print 更新')
    process.exit(1)
  }
  console.log('✓ associations 与快照一致')
  process.exit(0)
}
console.error('用法: node scripts/generate-builder-associations.mjs [print|check]')
process.exit(2)
