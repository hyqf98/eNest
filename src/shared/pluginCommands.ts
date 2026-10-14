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
      if (!isRecord(command) || (command.type !== 'regex' && command.type !== 'over')) {
        issues.push(`${commandPath} 必须是文本、regex 或 over 指令`)
        return
      }
      if (!isNonemptyString(command.label)) issues.push(`${commandPath}.label 必须是非空字符串`)
      const allowed = command.type === 'regex'
        ? ['type', 'label', 'match', 'regex', 'minLength']
        : ['type', 'label', 'exclude', 'minLength', 'maxLength']
      for (const key of Object.keys(command)) {
        if (!allowed.includes(key)) issues.push(`${commandPath}.${key} 不属于 ${command.type} 指令字段`)
      }
      for (const key of ['minLength', ...(command.type === 'over' ? ['maxLength'] : [])]) {
        if (command[key] !== undefined && !isLength(command[key])) issues.push(`${commandPath}.${key} 必须是非负安全整数`)
      }
      if (command.type === 'regex') {
        const pattern = command.match ?? command.regex
        if (!parsePluginCommandPattern(pattern)) {
          issues.push(`${commandPath}.match（或 regex）必须是有效的 /source/flags，且不超过 ${PLUGIN_COMMAND_PATTERN_MAX_LENGTH} 字符`)
        }
        if (command.match !== undefined && command.regex !== undefined && !parsePluginCommandPattern(command.regex)) {
          issues.push(`${commandPath}.regex 若提供必须是有效的 /source/flags；同时提供时 match 优先`)
        }
      } else {
        if (command.exclude !== undefined && !parsePluginCommandPattern(command.exclude)) {
          issues.push(`${commandPath}.exclude 必须是有效的 /source/flags，且不超过 ${PLUGIN_COMMAND_PATTERN_MAX_LENGTH} 字符`)
        }
        const min = command.minLength ?? 1
        const max = command.maxLength ?? 10000
        if (isLength(min) && isLength(max) && max < min) issues.push(`${commandPath}.maxLength 不能小于 minLength（缺省为 1）`)
      }
    })
  })
  return issues
}
