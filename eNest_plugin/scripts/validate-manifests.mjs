#!/usr/bin/env node
// validate-manifests — 用 docs/plugin-manifest.schema.json 校验 plugins/*/plugin.json
// ajv 2020 draft（根 node_modules 的 ajv@8）；allErrors 全量收集，pretty 输出，失败非零退出。
// CI（release.yml）与本地均使用；build-registry.mjs 聚合前复用同一逻辑（失败直接抛错）。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const pluginsDir = join(root, 'plugins')
const schemaPath = join(root, 'docs', 'plugin-manifest.schema.json')

/** 加载 schema 并编译校验器（供 build-registry 复用） */
export function loadManifestValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'))
  return ajv.compile(schema)
}

/** 校验单个 manifest 对象；返回 pretty 错误行数组（空 = 通过） */
export function validateManifest(validator, manifest, label) {
  if (validator(manifest)) return []
  const errors = validator.errors ?? []
  return errors.map(
    (e) =>
      `${label}: ${e.instancePath || '(root)'} ${e.message ?? ''}${
        e.params && Object.keys(e.params).length
          ? ` (${JSON.stringify(e.params)})`
          : ''
      }`.replace(/\s+/g, ' ')
  )
}

/** 校验全部 plugins 下各插件的 plugin.json；返回全部错误行（空 = 全部通过） */
export function validateAllManifests() {
  if (!existsSync(pluginsDir)) return []
  const validator = loadManifestValidator()
  const errors = []
  const dirs = readdirSync(pluginsDir)
  for (const dir of dirs) {
    const manifestPath = join(pluginsDir, dir, 'plugin.json')
    if (!existsSync(manifestPath)) continue
    let m
    try {
      m = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    } catch (e) {
      errors.push(`${relative(root, manifestPath)}: invalid JSON — ${e.message}`)
      continue
    }
    if (m.id !== dir) {
      errors.push(`${dir}: folder name must equal id (${m.id})`)
    }
    errors.push(...validateManifest(validator, m, relative(root, manifestPath)))
  }
  return errors
}

// 直接执行（非 import）时作为 CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = validateAllManifests()
  if (errors.length) {
    console.error(`[validate-manifests] ${errors.length} error(s):`)
    for (const line of errors) console.error(`  - ${line}`)
    process.exit(1)
  }
  console.log('[validate-manifests] all plugin.json valid')
}
