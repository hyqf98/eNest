/** Plugin command metadata validation. Matching runs separately in an isolated worker. */
export const PLUGIN_COMMAND_PATTERN_MAX_LENGTH = 2048

export interface PluginCommandPattern {
  source: string
  flags: string
}

/** Parse a /source/flags literal and check syntax without executing it against input. */
export function parsePluginCommandPattern(value: unknown): PluginCommandPattern | null {
  if (typeof value !== 'string' || value.length > PLUGIN_COMMAND_PATTERN_MAX_LENGTH || value[0] !== '/') return null
  const end = value.lastIndexOf('/')
  if (end <= 1) return null
  const source = value.slice(1, end)
  const flags = value.slice(end + 1)
  if ([...flags].some((flag) => !'dgimsuvy'.includes(flag)) || new Set(flags).size !== flags.length) return null
  try {
    // Compilation only: even a syntactically valid pattern may be expensive to match.
    new RegExp(source, flags)
    return { source, flags }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isLength(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isExtensions(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 16 &&
    value.every(extension => typeof extension === 'string' && /^[a-z0-9]{1,10}$/.test(extension))
}

/** Returns field paths so a rejected package can be fixed without guessing its bad command. */
export function collectPluginFeatureIssues(features: unknown): string[] {
  if (features === undefined) return []
  if (!Array.isArray(features)) return ['features 必须是数组']
  const issues: string[] = []
  const codes = new Set<string>()
  features.forEach((feature, featureIndex) => {
    const featurePath = `features[${featureIndex}]`
    if (!isRecord(feature)) {
      issues.push(`${featurePath} 必须是对象`)
      return
    }
    if (!isNonemptyString(feature.code)) issues.push(`${featurePath}.code 必须是非空字符串`)
    else if (codes.has(feature.code)) issues.push(`${featurePath}.code 重复`)
    else codes.add(feature.code)
    if (feature.explain !== undefined && typeof feature.explain !== 'string') issues.push(`${featurePath}.explain 必须是字符串`)
    if (!Array.isArray(feature.cmds) || feature.cmds.length === 0) {
      issues.push(`${featurePath}.cmds 必须是非空数组`)
      return
    }
    feature.cmds.forEach((command, commandIndex) => {
      const commandPath = `${featurePath}.cmds[${commandIndex}]`
      if (typeof command === 'string') {
        if (!isNonemptyString(command)) issues.push(`${commandPath} 触发词不能为空`)
        return
      }
      if (!isRecord(command) || !['regex', 'over', 'img', 'files'].includes(String(command.type))) {
        issues.push(`${commandPath} 必须是文本、regex、over、img 或 files 指令`)
        return
      }
      if (!isNonemptyString(command.label)) issues.push(`${commandPath}.label 必须是非空字符串`)
      const allowed: Record<string, string[]> = {
        regex: ['type', 'label', 'match', 'regex', 'minLength'],
        over: ['type', 'label', 'exclude', 'minLength', 'maxLength'],
        img: ['type', 'label', 'extensions'],
        files: ['type', 'label', 'extensions', 'minCount', 'maxCount', 'allowDirectory']
      }
      for (const key of Object.keys(command)) {
        if (!allowed[String(command.type)].includes(key)) issues.push(`${commandPath}.${key} 不属于 ${command.type} 指令字段`)
      }
      if (command.type === 'regex' || command.type === 'over') {
        for (const key of ['minLength', ...(command.type === 'over' ? ['maxLength'] : [])]) {
          if (command[key] !== undefined && !isLength(command[key])) issues.push(`${commandPath}.${key} 必须是非负安全整数`)
        }
      }
      if (command.extensions !== undefined && !isExtensions(command.extensions)) {
        issues.push(`${commandPath}.extensions 必须是最多 16 个小写扩展名（1-10 位字母数字，不含点）`)
      }
      if (command.type === 'regex') {
        const pattern = command.match ?? command.regex
        if (!parsePluginCommandPattern(pattern)) {
          issues.push(`${commandPath}.match（或 regex）必须是有效的 /source/flags，且不超过 ${PLUGIN_COMMAND_PATTERN_MAX_LENGTH} 字符`)
        }
        if (command.match !== undefined && command.regex !== undefined && !parsePluginCommandPattern(command.regex)) {
          issues.push(`${commandPath}.regex 若提供必须是有效的 /source/flags；同时提供时 match 优先`)
        }
      } else if (command.type === 'over') {
        if (command.exclude !== undefined && !parsePluginCommandPattern(command.exclude)) {
          issues.push(`${commandPath}.exclude 必须是有效的 /source/flags，且不超过 ${PLUGIN_COMMAND_PATTERN_MAX_LENGTH} 字符`)
        }
        const min = command.minLength ?? 1
        const max = command.maxLength ?? 10000
        if (isLength(min) && isLength(max) && max < min) issues.push(`${commandPath}.maxLength 不能小于 minLength（缺省为 1）`)
      } else if (command.type === 'files') {
        const min = command.minCount ?? 1
        const max = command.maxCount ?? 20
        if (command.minCount !== undefined && !(isLength(min) && min >= 1 && min <= 20)) issues.push(`${commandPath}.minCount 必须是 1-20 的整数`)
        if (command.maxCount !== undefined && !(isLength(max) && max >= 1 && max <= 20)) issues.push(`${commandPath}.maxCount 必须是 1-20 的整数`)
        if (isLength(min) && isLength(max) && min >= 1 && max >= 1 && max < min) issues.push(`${commandPath}.maxCount 不能小于 minCount`)
        if (command.allowDirectory !== undefined && typeof command.allowDirectory !== 'boolean') issues.push(`${commandPath}.allowDirectory 必须是布尔值`)
      }
    })
  })
  return issues
}
