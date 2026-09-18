/**
 * @enest/plugin-sdk — plugin.json manifest 校验
 *
 * 用包内自含的 manifest-schema.json（上游 eNest_plugin/docs/plugin-manifest.schema.json
 * 的复制，见 x-upstream 字段）经 ajv 2020 draft 校验插件清单。
 *
 * ajv ^8 为 peerDependency（optional）：SDK 本身不携带依赖，优先解析宿主/仓库根
 * node_modules 中的 ajv；缺失时返回 { ok: false, errors: [{ message }] } 提示安装。
 *
 * 用法（Node ESM）：
 *   import { validateManifest, loadAjv } from '@enest/plugin-sdk/validate'
 *   const result = validateManifest(json)
 *   // { ok: true } | { ok: false, errors: string[] }
 */

/** 动态解析 ajv（2020 draft 入口）。查找顺序：裸 'ajv/dist/2020.js' → 相对本包上溯的 node_modules */
export async function loadAjv() {
  const spec = 'ajv/dist/2020.js'
  try {
    return (await import(spec)).default
  } catch {
    // 相对导入失败（不在宿主 node_modules 旁）→ 沿目录树找仓库根 node_modules
    const { createRequire } = await import('node:module')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    for (let dir = here; dir !== '/' && !dir.endsWith('node_modules'); dir = dirname(dir)) {
      try {
        const req = createRequire(join(dir, 'package.json'))
        return req(spec).default
      } catch {
        // 继续上溯
      }
    }
    throw new Error(
      "ajv not found — @enest/plugin-sdk 的 manifest 校验需要 peerDependency ajv ^8（npm i -D ajv）"
    )
  }
}

/** 编译好的 ajv 校验器（懒加载缓存） */
let cached = null

async function getValidator() {
  if (cached) return cached
  const Ajv2020 = await loadAjv()
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const schemaPath = new URL('./manifest-schema.json', import.meta.url)
  const schema = JSON.parse(readFileSync(fileURLToPath(schemaPath), 'utf-8'))
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  cached = ajv.compile(schema)
  return cached
}

/** ajv 错误行 → 人读字符串 */
function prettyError(e) {
  const at = e.instancePath || '(root)'
  const params =
    e.params && Object.keys(e.params).length ? ` (${JSON.stringify(e.params)})` : ''
  return `${at} ${e.message ?? 'invalid'}${params}`.replace(/\s+/g, ' ').trim()
}

/**
 * 校验 manifest 对象。
 * @param {unknown} obj — 解析后的 plugin.json 对象
 * @returns {Promise<{ok: boolean, errors: string[]}>}
 *   ok=true 通过；errors 为 pretty 错误行（ajv 缺失时也走 errors 通道，不抛异常）
 */
export async function validateManifest(obj) {
  let validator
  try {
    validator = await getValidator()
  } catch (e) {
    return { ok: false, errors: [String(e?.message ?? e)] }
  }
  if (validator(obj)) return { ok: true, errors: [] }
  const errors = (validator.errors ?? []).map(prettyError)
  return { ok: false, errors: errors.length ? errors : ['manifest invalid (unknown reason)'] }
}

/**
 * 便捷封装：读文件 → JSON.parse → 校验。
 * @param {string} path — plugin.json 路径
 * @returns {Promise<{ok: boolean, errors: string[], manifest?: object}>}
 */
export async function validateManifestFile(path) {
  const { readFileSync } = await import('node:fs')
  let raw
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (e) {
    return { ok: false, errors: [`cannot read ${path}: ${e.message}`] }
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (e) {
    return { ok: false, errors: [`${path}: invalid JSON — ${e.message}`] }
  }
  const result = await validateManifest(manifest)
  return { ...result, manifest }
}
