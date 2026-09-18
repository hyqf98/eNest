#!/usr/bin/env node
/**
 * enest-validate — eNest 插件 manifest 校验 CLI
 *
 * 用法：
 *   node packages/plugin-sdk/bin/enest-validate.mjs <path/to/plugin.json> [more.json ...]
 *   # workspaces 接线后也可：npx enest-validate ./plugin.json
 *
 * 行为：ajv（2020 draft）+ 包内 manifest-schema.json 全量校验，
 * pretty 输出全部错误行，失败 exit 1；额外做「目录名 === id」启发式检查。
 * 依赖解析：优先宿主 node_modules 的 ajv ^8（peerDep，需自行安装）。
 */
import { validateManifestFile } from '../src/validate.mjs'
import { basename, dirname } from 'node:path'

const args = process.argv.slice(2)
const paths = args.filter((a) => !a.startsWith('-'))
const quiet = args.includes('-q') || args.includes('--quiet')

if (!paths.length) {
  console.log('Usage: enest-validate <plugin.json> [plugin.json ...]')
  process.exit(args.includes('-h') || args.includes('--help') ? 0 : 2)
}

let failed = 0
for (const p of paths) {
  const { ok, errors, manifest } = await validateManifestFile(p)
  if (ok) {
    // 启发式：目录名应等于 id（eNest_plugin monorepo 的硬约束）
    const dir = basename(dirname(p))
    const idOk = manifest && manifest.id === dir
    if (idOk || quiet) {
      if (!quiet) console.log(`ok  ${p}`)
    } else {
      console.warn(`warn  ${p}: folder name "${dir}" !== manifest.id "${manifest?.id}"`)
    }
  } else {
    failed++
    console.error(`FAIL ${p}`)
    for (const line of errors) console.error(`  - ${line}`)
  }
}

if (failed) {
  console.error(`\n${failed} manifest(s) invalid`)
  process.exit(1)
}
if (!quiet) console.log(`\nall ${paths.length} manifest(s) valid`)
