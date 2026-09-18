#!/usr/bin/env node
/**
 * pack-plugin — 将 plugins/<id> 打成 {id}@{version}.enestplugin（zip）
 * 用法: node scripts/pack-plugin.mjs <pluginId> [outdir]
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

// 简易 zip：使用系统 zip 更稳妥；无 zip 时提示
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const id = process.argv[2]
if (!id) {
  console.error('usage: node scripts/pack-plugin.mjs <pluginId> [outdir]')
  process.exit(1)
}

const src = join(root, 'plugins', id)
const manifestPath = join(src, 'plugin.json')
if (!existsSync(manifestPath)) {
  console.error(`missing ${manifestPath}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
const version = manifest.version
// outDir/outPath 必须是绝对路径：zip 以 src 为 cwd，相对路径会写到插件目录下
const outDir = resolve(root, process.argv[3] || join(root, 'dist'))
mkdirSync(outDir, { recursive: true })

const outName = `${id}@${version}.enestplugin`
const outPath = join(outDir, outName)

try {
  execFileSync('zip', ['-r', '-q', outPath, '.'], { cwd: src, stdio: 'inherit' })
} catch {
  console.error('zip command failed — install zip or pack manually')
  process.exit(1)
}

const buf = readFileSync(outPath)
const sha256 = createHash('sha256').update(buf).digest('hex')
console.log(JSON.stringify({ name: outName, path: outPath, size: buf.length, sha256 }, null, 2))
