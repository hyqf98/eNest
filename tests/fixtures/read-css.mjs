import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url))

/** Expand local CSS imports in place so inline fixtures retain the real cascade. */
export function readCss(entry) {
  function expand(filename, ancestry = []) {
    if (ancestry.includes(filename)) throw new Error(`CSS import cycle: ${[...ancestry, filename].join(' -> ')}`)
    const css = readFileSync(filename, 'utf8')
    let output = '', cursor = 0
    for (let index = 0; index < css.length; index++) {
      if (css.startsWith('/*', index)) {
        const end = css.indexOf('*/', index + 2)
        if (end === -1) throw new Error(`${filename}: unterminated CSS comment`)
        index = end + 1
        continue
      }
      if (css[index] === "'" || css[index] === '"') {
        const quote = css[index]
        let end = index + 1
        for (; end < css.length; end++) {
          if (css[end] === '\\') end++
          else if (css[end] === quote) break
        }
        if (end >= css.length) throw new Error(`${filename}: unterminated CSS string`)
        index = end
        continue
      }
      if (css.slice(index, index + 7).toLowerCase() !== '@import' || /[-\w]/.test(css[index + 7] ?? '')) continue
      // Conditional or escaped imports need a real CSS processor, not silent omission.
      const imported = css.slice(index).match(/^@import\s+(?:'([^'\\\r\n]+)'|"([^"\\\r\n]+)"|url\(\s*(?:'([^'\\\r\n]+)'|"([^"\\\r\n]+)")\s*\))\s*;/i)
      if (!imported) throw new Error(`${filename}: unsupported CSS import ${css.slice(index).split(';', 1)[0]}`)
      const specifier = imported.slice(1).find(Boolean)
      const target = specifier.startsWith('@renderer/')
        ? resolve(sourceRoot, 'renderer', specifier.slice('@renderer/'.length))
        : specifier.startsWith('@shared/')
          ? resolve(sourceRoot, 'shared', specifier.slice('@shared/'.length))
          : specifier.startsWith('.') ? resolve(dirname(filename), specifier) : undefined
      if (!target) throw new Error(`${filename}: unsupported CSS import ${specifier}`)
      output += css.slice(cursor, index) + expand(target, [...ancestry, filename])
      index += imported[0].length - 1
      cursor = index + 1
    }
    return output + css.slice(cursor)
  }
  return expand(entry instanceof URL ? fileURLToPath(entry) : resolve(entry))
}
