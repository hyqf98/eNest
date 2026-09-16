#!/usr/bin/env node
/**
 * rewrite-imports — 将 src 内相对导入改写为 @main / @preload / @renderer / @shared 别名
 * 仅改写模块说明符，不改逻辑。可重复执行（幂等）。
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src')

const ROOTS = [
  { prefix: '@main', dir: 'src/main' },
  { prefix: '@preload', dir: 'src/preload' },
  { prefix: '@renderer', dir: 'src/renderer' },
  { prefix: '@shared', dir: 'src/shared' },
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

/** 解析相对路径到 src 下的别名模块 */
function toAlias(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const abs = resolve(dirname(fromFile), spec)
  const relFromSrc = relative(src, abs).split(sep).join('/')
  if (relFromSrc.startsWith('..')) return null
  for (const { prefix, dir } of ROOTS) {
    const base = dir.replace(/^src\//, '')
    if (relFromSrc === base) return prefix
    if (relFromSrc.startsWith(base + '/')) {
      return `${prefix}/${relFromSrc.slice(base.length + 1)}`
    }
  }
  return null
}

function rewriteFile(file) {
  const raw = readFileSync(file, 'utf-8')
  let changed = false
  const next = raw.replace(
    /(from\s+|import\s*\(\s*)(['"])(\.[^'"]+)\2/g,
    (full, lead, q, spec) => {
      const aliased = toAlias(file, spec)
      if (!aliased) return full
      changed = true
      return `${lead}${q}${aliased}${q}`
    }
  )
  // type-only / export from
  const next2 = next.replace(
    /(export\s+\*?\s*\{[^}]*\}\s*from\s+)(['"])(\.[^'"]+)\2/g,
    (full, lead, q, spec) => {
      const aliased = toAlias(file, spec)
      if (!aliased) return full
      changed = true
      return `${lead}${q}${aliased}${q}`
    }
  )
  const out = next2
  if (changed && out !== raw) {
    writeFileSync(file, out, 'utf-8')
    return 1
  }
  return 0
}

let n = 0
for (const f of walk(src)) n += rewriteFile(f)
console.log(`[rewrite-imports] updated ${n} files`)
