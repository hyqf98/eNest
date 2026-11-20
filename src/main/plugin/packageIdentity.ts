import manifestSchema from '@shared/pluginManifest.schema.json'

const idPattern = new RegExp(manifestSchema.properties.id.pattern)
const versionPattern = new RegExp(manifestSchema.properties.version.pattern)

export function isPackageId(value: unknown): value is string {
  return typeof value === 'string' && value !== manifestSchema.properties.id.not.const && idPattern.test(value)
}

export function isPackageVersion(value: unknown): value is string {
  return typeof value === 'string' && versionPattern.test(value)
}

function compareNumeric(left: string, right: string): number {
  left = left.replace(/^0+(?=\d)/, '')
  right = right.replace(/^0+(?=\d)/, '')
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
}

export function compareVersions(left: string, right: string): number {
  const first = versionPattern.exec(left), second = versionPattern.exec(right)
  if (!first || !second) return Number(!!first) - Number(!!second)
  for (let part = 1; part <= 3; part++) {
    const order = compareNumeric(first[part], second[part])
    if (order) return order
  }
  if (!first[4] || !second[4]) return Number(!first[4]) - Number(!second[4])
  const firstPre = first[4].split('.'), secondPre = second[4].split('.')
  for (let part = 0; part < Math.min(firstPre.length, secondPre.length); part++) {
    const lhs = firstPre[part], rhs = secondPre[part]
    const numericLeft = /^\d+$/.test(lhs), numericRight = /^\d+$/.test(rhs)
    const order = numericLeft && numericRight ? compareNumeric(lhs, rhs) : numericLeft !== numericRight
      ? (numericLeft ? -1 : 1) : lhs < rhs ? -1 : lhs > rhs ? 1 : 0
    if (order) return order
  }
  return firstPre.length - secondPre.length
}

export function selectsInstalledVersion(candidate: string, previous?: string): boolean {
  return !previous || candidate === previous || compareVersions(candidate, previous) > 0
}
