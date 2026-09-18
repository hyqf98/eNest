#!/usr/bin/env node
/**
 * generate-api-types — 从 src/preload/pluginPreload.ts 自动生成插件开发者类型与文档
 *
 * 产物：
 *   1. packages/plugin-sdk/src/enest-api.d.ts
 *      EnestPluginApi 及其依赖类型（含 @shared/types/plugin 引用链）+ window 全局声明。
 *      发布在 @enest/plugin-sdk 中，供插件开发者 import type / triple-slash reference 使用。
 *   2. docs/site/plugin/api-types.md
 *      头部「自动生成，勿手改」横幅 + 时间戳 + 从 d.ts 渲染的 ts 代码块。
 *
 * 原理：TypeScript Compiler API（devDeps 的 typescript）。
 *   createSourceFile 解析 pluginPreload.ts → 打印 export interface EnestPluginApi；
 *   随后迭代扫描打印文本中引用的类型名，在 pluginPreload.ts 本地类型与
 *   @shared/types/plugin.ts 的导出类型中定位同名声明并打印，直至收敛。
 *   printer.printNode 保留 JSDoc；对源文件无副作用。
 *
 * 幂等可重复执行：node scripts/generate-api-types.mjs
 * pluginPreload.ts / plugin.ts 变更后重跑即可（例如 contribute 类 API 合入后）。
 */
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const preloadPath = join(root, 'src/preload/pluginPreload.ts')
const sharedTypesPath = join(root, 'src/shared/types/plugin.ts')
const sdkDtsPath = join(root, 'packages/plugin-sdk/src/enest-api.d.ts')
const docsApiTypesPath = join(root, 'docs/site/plugin/api-types.md')

const API_NAME = 'EnestPluginApi'

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
const banner = (source) => `/**
 * eNest 插件运行时 API 类型 —— 自动生成，勿手改。
 * 由 scripts/generate-api-types.mjs 从 ${source} 提取。
 * 生成时间：${stamp}
 * 重新生成：node scripts/generate-api-types.mjs
 */

`

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })

function parse(path) {
  return ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true)
}

/** 收集 sourceFile 顶层 interface / type alias 声明（含未 export 的本地类型，如 Unsubscribe） */
function collectTypes(sourceFile) {
  const map = new Map()
  for (const stmt of sourceFile.statements) {
    if (
      stmt.kind === ts.SyntaxKind.InterfaceDeclaration ||
      stmt.kind === ts.SyntaxKind.TypeAliasDeclaration
    ) {
      map.set(stmt.name.text, stmt)
    }
  }
  return map
}

const preloadSf = parse(preloadPath)
const sharedSf = parse(sharedTypesPath)
const preloadTypes = collectTypes(preloadSf)
const sharedTypes = collectTypes(sharedSf)

const apiNode = preloadTypes.get(API_NAME)
if (!apiNode) {
  console.error(`[generate-api-types] interface ${API_NAME} not found in ${preloadPath}`)
  process.exit(1)
}

const apiText = printer.printNode(ts.EmitHint.Unspecified, apiNode, preloadSf)

/** 迭代收集依赖类型：preload 本地类型优先，其次 @shared/types/plugin 导出类型 */
const emitted = new Set([API_NAME])
const preloadDeps = []
const sharedDeps = []
const worklist = []

function scanRefs(text) {
  for (const name of preloadTypes.keys()) {
    if (name !== API_NAME && !emitted.has(name) && new RegExp(`\\b${name}\\b`).test(text)) {
      worklist.push({ name, from: 'preload' })
      emitted.add(name)
    }
  }
  for (const name of sharedTypes.keys()) {
    if (!emitted.has(name) && new RegExp(`\\b${name}\\b`).test(text)) {
      worklist.push({ name, from: 'shared' })
      emitted.add(name)
    }
  }
}

scanRefs(apiText)
while (worklist.length) {
  const { name, from } = worklist.shift()
  const node = from === 'preload' ? preloadTypes.get(name) : sharedTypes.get(name)
  if (!node) continue
  const text = printer.printNode(ts.EmitHint.Unspecified, node, from === 'preload' ? preloadSf : sharedSf)
  ;(from === 'preload' ? preloadDeps : sharedDeps).push({ name, text })
  scanRefs(text)
}

/**
 * 打印文本可能自带 `export` 修饰符（源文件里声明为 export），
 * 统一剥掉后由调用方补恰好一个，避免 `export export`；
 * 前置 JSDoc 保持在声明体上（跟随声明），输出顺序为 export → JSDoc → 声明体。
 */
function emitDeclaration(text) {
  const m = text.match(/^(\s*)(\/\*\*[\s\S]*?\*\/\s*)?(export\s+)?/)
  const [, indent = '', jsdoc = ''] = m
  const body = text.slice(m[0].length)
  return `${indent}export ${jsdoc}${body}`.replace(/\s+$/, '')
}

const block = ({ name, text }, source) =>
  `\n// —— ${name}（${source}）——\n\n${emitDeclaration(text)}\n`

const globalBlock = `
// —— window 全局挂载 ——
// preload 同时暴露 enest 与 zapi 两个全局名（同一对象）；
// zapi 为 @deprecated 历史别名，保留兼容，计划 v2 移除。示例统一使用 enest.*。
declare global {
  interface Window {
    /** eNest 插件 API（正式命名） */
    enest: ${API_NAME}
    /** @deprecated 历史别名，与 window.enest 同一对象；计划 v2 移除 */
    zapi: ${API_NAME}
  }
}

export {}
`

const dts =
  banner('src/preload/pluginPreload.ts') +
  `// 主接口：与壳子 preload 实际注入的 window.enest 严格一致\n` +
  `${emitDeclaration(apiText)}\n` +
  preloadDeps.map((d) => block(d, 'src/preload/pluginPreload.ts')).join('') +
  sharedDeps.map((d) => block(d, 'src/shared/types/plugin.ts')).join('') +
  globalBlock

fs.mkdirSync(dirname(sdkDtsPath), { recursive: true })
fs.writeFileSync(sdkDtsPath, dts, 'utf8')
console.log(`[generate-api-types] wrote ${join('packages/plugin-sdk/src', 'enest-api.d.ts')}`)
console.log(
  `  EnestPluginApi + ${preloadDeps.length} preload deps + ${sharedDeps.length} shared deps` +
    (preloadDeps.length + sharedDeps.length
      ? `: ${[...preloadDeps, ...sharedDeps].map((d) => d.name).join(', ')}`
      : '')
)

// —— 产物 2：docs/site/plugin/api-types.md ——
const doc = `# TypeScript 类型定义

!> **本文件由 \`scripts/generate-api-types.mjs\` 生成，勿手改。**
> 上游源：\`src/preload/pluginPreload.ts\`（\`EnestPluginApi\` 及其本地类型）+ \`src/shared/types/plugin.ts\`（共享类型）。
> 生成时间：**${stamp}** · 重新生成：\`node scripts/generate-api-types.mjs\`
>
> 推荐直接安装 [\`@enest/plugin-sdk\`](../../../packages/plugin-sdk/README.md)（含本 d.ts + manifest 校验 CLI）；
> 也可将下方声明保存为项目内 \`enest-api.d.ts\`，经 \`/// <reference path="./enest-api.d.ts" />\` 引入。

在 TypeScript 插件工程中引用下列类型描述 \`window.enest\` / \`window.zapi\`，避免手写 \`any\`。

## 类型声明（enest-api.d.ts）

\`\`\`ts
${dts.trimEnd()}
\`\`\`

## 使用示例

\`\`\`ts
/// <reference path="./enest-api.d.ts" />

async function boot() {
  const api = window.enest
  await api.ui.setTitle('我的插件')
  await api.ui.toast({ message: 'API 就绪', type: 'success' })
}

void boot()
\`\`\`

## 全局挂载说明

| 全局名 | 说明 |
|--------|------|
| \`window.enest\` | 正式命名，推荐使用 |
| \`window.zapi\` | \`@deprecated\` 历史别名，与 \`window.enest\` 同一对象；保留兼容，计划 v2 移除 |

## 与权限的关系

类型只描述「有哪些方法」；能否调用成功取决于 \`plugin.json\` 的 \`permissions\`。未声明权限时对应 Promise 会 reject，错误文案见 [错误码](errors.md)。
`

fs.writeFileSync(docsApiTypesPath, doc, 'utf8')
console.log(`[generate-api-types] wrote docs/site/plugin/api-types.md`)
