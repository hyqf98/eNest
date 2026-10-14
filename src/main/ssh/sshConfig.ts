import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { resolveLocalFileHandle } from '@main/plugin/localFiles'
import type { SshJumpConfig } from '@shared/types/ssh-db'

interface ConfigBlock { patterns: string[]; values: Map<string, string> }
interface ImportedProfile extends SshJumpConfig { privateKeyHint?: string; agentHint?: string; name: string; jumps?: SshJumpConfig[]; keepAliveSec?: number; timeoutMs?: number }
export interface SshConfigImport { profiles: ImportedProfile[]; warnings: string[] }

function tokenize(line: string): string[] {
  const words: string[] = []; let token = '', quote = '', escape = false
  for (const char of line) {
    if (escape) { token += char; escape = false; continue }
    if (char === '\\' && quote !== "'") { escape = true; continue }
    if (quote) { if (char === quote) quote = ''; else token += char; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '#') break
    if (/\s/.test(char)) { if (token) { words.push(token); token = '' } } else token += char
  }
  if (escape) token += '\\'
  if (token) words.push(token)
  return words
}
function matches(pattern: string, name: string): boolean {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(name)
}

/** OpenSSH first-value-wins semantics. Never execute Match exec or ProxyCommand. */
export function parseOpenSshConfig(raw: string, sourcePath: string, defaultUser = userInfo().username): SshConfigImport {
  const warnings = new Set<string>(), blocks: ConfigBlock[] = [{ patterns: ['*'], values: new Map() }]
  let current = blocks[0]
  for (const line of raw.replace(/\r/g, '').split('\n')) {
    const parts = tokenize(line.replace(/^(\s*[^\s=]+)\s*=\s*/, '$1 ')); if (!parts.length) continue
    const key = parts.shift()!.toLowerCase(), value = parts.join(' ')
    if (key === 'host') { current = { patterns: parts, values: new Map() }; blocks.push(current); continue }
    if (key === 'match') { warnings.add('Match 条件块未导入；请核实对应连接。'); current = { patterns: [], values: new Map() }; blocks.push(current); continue }
    if (key === 'include') { warnings.add(`Include ${value} 未展开，请单独导入该配置文件。`); continue }
    if (key === 'proxycommand') warnings.add('ProxyCommand 不会执行；请在跳板链中配置对应服务器。')
    if (key === 'localforward' || key === 'remoteforward' || key === 'dynamicforward') warnings.add('配置中的自动端口转发未启用，请在隧道面板建立转发。')
    if (!current.values.has(key)) current.values.set(key, value)
  }
  const aliases = [...new Set(blocks.flatMap(b => b.patterns.filter(p => p && !/[*!?]/.test(p))))]
  function options(alias: string): Map<string, string> {
    const result = new Map<string, string>()
    for (const block of blocks) {
      if (!block.patterns.some(p => !p.startsWith('!') && matches(p, alias)) || block.patterns.some(p => p.startsWith('!') && matches(p.slice(1), alias))) continue
      for (const [key, value] of block.values) if (!result.has(key)) result.set(key, value)
    }
    return result
  }
  function profile(alias: string, override: Partial<SshJumpConfig> = {}): ImportedProfile {
    const values = options(alias), host = values.get('hostname')?.replaceAll('%h', alias) || alias, username = override.username || values.get('user') || defaultUser
    const port = override.port || Number(values.get('port')) || 22
    const expand = (value: string): string => value.replace(/^~(?=[/\\]|$)/, homedir()).replace(/%([dhrp%])/g, (_, key: string) => ({ d: homedir(), h: host, r: username, p: String(port), '%': '%' })[key] || '')
    const identity = values.get('identityfile'), agent = values.get('identityagent')
    const privateKeyPath = identity && identity !== 'none' ? expand(identity) : undefined
    const result: ImportedProfile = { name: alias, host, port, username, authType: privateKeyPath ? 'key' : values.get('passwordauthentication') === 'yes' ? 'password' : 'agent' }
    if (privateKeyPath) result.privateKeyHint = isAbsolute(privateKeyPath) ? privateKeyPath : resolve(dirname(sourcePath), privateKeyPath)
    if (agent && agent !== 'SSH_AUTH_SOCK' && agent !== 'none') result.agentHint = expand(agent)
    if (agent === 'none' && !privateKeyPath) result.authType = 'password'
    if (values.get('serveraliveinterval')) result.keepAliveSec = Number(values.get('serveraliveinterval')) || undefined
    if (values.get('connecttimeout')) result.timeoutMs = (Number(values.get('connecttimeout')) || 20) * 1000
    return result
  }
  function jumpChain(alias: string, seen = new Set<string>()): SshJumpConfig[] {
    if (seen.has(alias) || seen.size >= 8) throw new Error(`ProxyJump 存在循环或超过 8 层：${alias}`)
    seen = new Set([...seen, alias])
    const proxy = options(alias).get('proxyjump'); if (!proxy || proxy === 'none') return []
    const result: SshJumpConfig[] = []
    for (const token of proxy.split(',')) {
      const match = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(token.trim())
      if (!match) throw new Error(`无法解析 ProxyJump：${token}`)
      const name = match[2].replace(/^\[|\]$/g, '')
      result.push(...jumpChain(name, seen))
      const { name: _name, ...hop } = profile(name, { username: match[1], port: match[3] ? Number(match[3]) : undefined })
      result.push(hop)
    }
    if (result.length > 8) throw new Error('ProxyJump 超过 8 层')
    return result
  }
  const profiles = aliases.map(alias => { const result = profile(alias); try { const jumps = jumpChain(alias); if (jumps.length) result.jumps = jumps } catch (e) { warnings.add((e as Error).message) }; return result })
  if (blocks.some(b => b.patterns.some(p => /[*?]/.test(p) && p !== '*'))) warnings.add('通配 Host 已作为默认配置应用；仅导入具有明确名称的 Host。')
  return { profiles, warnings: [...warnings] }
}

export async function importSshConfig(pluginId: string, localHandleId: string): Promise<SshConfigImport> {
  const path = await resolveLocalFileHandle(pluginId, localHandleId)
  const data = await readFile(path)
  if (data.length > 1024 * 1024) throw new Error('SSH 配置文件超过 1 MB')
  return parseOpenSshConfig(new TextDecoder('utf8', { fatal: true }).decode(data), path)
}
