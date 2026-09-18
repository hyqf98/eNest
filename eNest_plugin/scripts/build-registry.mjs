#!/usr/bin/env node
// build-registry — 扫描 plugins/<id>/plugin.json 生成 registry.json
// 约定：目录名 === id；category 必须在枚举内；version 为 semver。
// 聚合前先跑 validate-manifests 的 schema 校验（失败直接抛错，不产出过期 registry）。
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateAllManifests } from './validate-manifests.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const pluginsDir = join(root, 'plugins')

const CATEGORIES = ['效率', '开发', '设计', '媒体', '其它']
const SCHEMA_VERSION = 1

function fail(msg) {
  console.error(`[registry] ${msg}`)
  process.exitCode = 1
}

// schema 校验（ajv）：任何 manifest 不合法直接终止
const schemaErrors = validateAllManifests()
if (schemaErrors.length) {
  for (const line of schemaErrors) console.error(`[registry] manifest invalid: ${line}`)
  throw new Error(`manifest validation failed (${schemaErrors.length} error(s)); registry not built`)
}

const plugins = []
const dirs = existsSync(pluginsDir) ? readdirSync(pluginsDir) : []

for (const dir of dirs) {
  const manifestPath = join(pluginsDir, dir, 'plugin.json')
  if (!existsSync(manifestPath)) continue
  let m
  try {
    m = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch (e) {
    fail(`${dir}: invalid plugin.json — ${e.message}`)
    continue
  }
  if (m.id !== dir) fail(`${dir}: folder name must equal id (${m.id})`)
  if (!m.version || !/^\d+\.\d+\.\d+/.test(String(m.version))) {
    fail(`${dir}: version must be semver`)
  }
  const category = CATEGORIES.includes(m.category) ? m.category : '其它'
  if (m.category && !CATEGORIES.includes(m.category)) {
    fail(`${dir}: category "${m.category}" not in ${CATEGORIES.join('/')}`)
  }

  const assetName = `${m.id}@${m.version}.enestplugin`
  plugins.push({
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description ?? '',
    author: m.author ?? '',
    category,
    icon: m.icon ? `icons/${m.id}${m.icon.slice(m.icon.lastIndexOf('.'))}` : '',
    tags: m.market?.tags ?? [],
    permissions: m.permissions ?? [],
    engines: m.engines ?? {},
    featured: !!m.market?.featured,
    installs: 0,
    ui: m.ui ?? {},
    asset: {
      name: assetName,
      // 由 release workflow 写入最终 URL；本地生成用相对名
      url: assetName,
      size: 0,
      sha256: ''
    }
  })
}

plugins.sort((a, b) => a.id.localeCompare(b.id))

const registry = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  channel: process.env.CHANNEL || 'stable',
  categories: CATEGORIES,
  plugins
}

const out = join(root, 'registry.json')
writeFileSync(out, JSON.stringify(registry, null, 2) + '\n', 'utf-8')
console.log(`[registry] wrote ${out} (${plugins.length} plugins)`)
