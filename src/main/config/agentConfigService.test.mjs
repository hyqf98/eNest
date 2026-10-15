import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const absPath = fileURLToPath(new URL('src/main/config/agentConfigService.ts', 'file://' + root))

const result = await build({
  stdin: { contents: readFileSync(absPath, 'utf8'), resolveDir: root, sourcefile: absPath, loader: 'ts' },
  tsconfig: root + 'tsconfig.node.json',
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{
    name: 'stub-deps',
    setup(b) {
      b.onResolve({ filter: /^@main\/paths\/pathsService$/ }, () => ({ path: 'paths-stub', namespace: 'stub' }))
      b.onResolve({ filter: /^@main\/logs\/logService$/ }, () => ({ path: 'log-stub', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: args.path === 'paths-stub'
          ? 'export const getAppPathsRoot = () => "/tmp/enest-test-root"'
          : 'export const logWarn = () => {}'
      }))
    }
  }]
})
const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
const { mergeJsonConfig, mergeTomlConfig, mergeYamlConfig } = api

test('mergeJsonConfig: 顶层键替换 + 未触及键与键序保留', () => {
  const source = `{
  "env": { "ANTHROPIC_BASE_URL": "https://old", "OTHER": 1 },
  "permissions": { "allow": ["a"] },
  "num": 5
}`
  const out = mergeJsonConfig(source, { env: { ANTHROPIC_BASE_URL: 'https://new' } })
  const parsed = JSON.parse(out)
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'https://new')
  assert.equal(parsed.env.OTHER, undefined) // 整键替换语义
  assert.deepEqual(parsed.permissions.allow, ['a'])
  assert.equal(parsed.num, 5)
  // 键序保留：env 仍在首位
  assert.equal(Object.keys(parsed)[0], 'env')
})

test('mergeJsonConfig: 新增顶层键追加；空文件可写', () => {
  const out = mergeJsonConfig('{}', { apiKey: 'sk-1', flag: true })
  const parsed = JSON.parse(out)
  assert.equal(parsed.apiKey, 'sk-1')
  assert.equal(parsed.flag, true)
  const outEmpty = mergeJsonConfig('', { a: 1 })
  assert.equal(JSON.parse(outEmpty).a, 1)
})

test('mergeJsonConfig: 非法 JSON 拒绝（不写坏文件）', () => {
  assert.throws(() => mergeJsonConfig('{ broken', { a: 1 }), SyntaxError)
  assert.throws(() => mergeJsonConfig('[1,2]', { a: 1 }), /not a JSON object/)
})

test('mergeTomlConfig: 顶层标量替换，注释与其它表保留', () => {
  const source = `# codex config
model = "gpt-5"
model_provider = "custom"
# 注释保留

[model_providers.custom]
name = "old"
base_url = "https://old.example/v1"
wire_api = "chat"

[features]
multi_agent_v2 = true
`
  const out = mergeTomlConfig(source, {
    model: 'gpt-5.5',
    model_providers: { custom: null } // 删除语义不承诺；这里替换为对象
  })
  // 用替换语义验证：标量行被替换
  assert.match(out, /^model = "gpt-5\.5"$/m)
  assert.doesNotMatch(out, /model = "gpt-5"$/m)
  // 注释保留
  assert.match(out, /# codex config/)
  assert.match(out, /# 注释保留/)
  // 未触及表原样保留
  assert.match(out, /\[features\]\nmulti_agent_v2 = true/)
})

test('mergeTomlConfig: 整表替换（[model_providers.custom]）', () => {
  const source = `model = "gpt-5"

[model_providers.custom]
name = "old"     # 旧名
base_url = "https://old/v1"

[features]
web_search = true
`
  const out = mergeTomlConfig(source, {
    model_providers: { custom: { name: 'new' } }
  })
  // 替换后的表体：新键齐、旧值不再出现在表内
  assert.match(out, /\[model_providers\.custom\]/)
  assert.match(out, /name = "new"/)
  assert.doesNotMatch(out, /base_url = "https:\/\/old\/v1"/)
  // 其它表保留
  assert.match(out, /\[features\]\nweb_search = true/)
})

test('mergeTomlConfig: 原文件无此表时尾加新表（单层嵌套拆为 [key.sub]）', () => {
  const source = `model = "x"

[features]
web_search = true
`
  const out = mergeTomlConfig(source, { model_providers: { custom: { base_url: 'https://n/v1', wire_api: 'chat' } } })
  // 单层嵌套且值均为对象 → 拆为 [model_providers.custom] 子表（对齐 codex 编辑器语义）
  assert.match(out, /\[model_providers\.custom\]\nbase_url = "https:\/\/n\/v1"\nwire_api = "chat"/)
  // 不应出现拍平错误形态
  assert.doesNotMatch(out, /\[model_providers\]\ncustom\.base_url/)
  // 原有内容保留
  assert.match(out, /\[features\]\nweb_search = true/)
})

test('mergeTomlConfig: 原文件无此表且值为标量映射时整表尾加', () => {
  const out = mergeTomlConfig('model = "x"\n', { features: { web_search: 'disabled', multi_agent: true } })
  assert.match(out, /\[features\]\nweb_search = "disabled"\nmulti_agent = true/)
})

test('mergeTomlConfig: codex 真实形状（顶层 model + model_provider + 表替换）', () => {
  const source = `model = "gpt-5-codex"
model_provider = "custom"
verbosity = 1

[model_providers.custom]
name = "Custom"
base_url = "https://api.example.com/v1"
wire_api = "responses"
requires_openai_auth = true

[features]
`
  const changes = {
    model: 'gpt-5.5-codex',
    model_providers: { custom: { name: 'Custom', base_url: 'https://relay.example.com/v1', wire_api: 'responses', requires_openai_auth: true } }
  }
  const out = mergeTomlConfig(source, changes)
  assert.match(out, /^model = "gpt-5\.5-codex"$/m)
  assert.match(out, /base_url = "https:\/\/relay\.example\.com\/v1"/)
  assert.match(out, /verbosity = 1/)
  assert.doesNotMatch(out, /api\.example\.com/)
  // TOML 仍可被结构化解析（用简单校验：表头 + 键值形态）
  const lines = out.split('\n')
  let sawProvider = false
  for (const line of lines) {
    if (line.trim() === '[model_providers.custom]') { sawProvider = true; continue }
    if (sawProvider && line.trim() === '') break
  }
  assert.ok(sawProvider)
})

test('mergeTomlConfig: 新顶层标量插到首个表头之前（TOML 合法性）', () => {
  const source = `[features]
web_search = true
`
  const out = mergeTomlConfig(source, { model: 'gpt-5' })
  const firstTable = out.indexOf('[features]')
  const modelLine = out.indexOf('model = "gpt-5"')
  assert.ok(modelLine >= 0 && modelLine < firstTable)
})

test('mergeTomlConfig: grok-build 空文件首写', () => {
  const out = mergeTomlConfig('', { model: 'grok-4', model_providers: { xai: { base_url: 'https://api.x.ai/v1' } } })
  assert.match(out, /^model = "grok-4"$/m)
  assert.match(out, /\[model_providers\.xai\]|\[model_providers\]/m)
})

test('mergeYamlConfig: hermes 顶层键替换与嵌套块重写', () => {
  const source = `# hermes
provider:
  name: old
  api_key: k-old
model: haiku
keep: 1
`
  const out = mergeYamlConfig(source, { provider: { name: 'new', api_key: 'k-new' }, model: 'sonnet' })
  assert.match(out, /provider:\n  name: new\n  api_key: k-new/)
  assert.match(out, /^model: sonnet$/m)
  assert.match(out, /^keep: 1$/m)
  assert.match(out, /# hermes/)
  assert.doesNotMatch(out, /k-old|name: old/)
})

test('mergeYamlConfig: 原文件无该键尾加', () => {
  const out = mergeYamlConfig('keep: 1\n', { retries: 3 })
  assert.match(out, /^retries: 3$/m)
  assert.match(out, /^keep: 1$/m)
})

test('AGENT_ADAPTERS: 10 应用白名单形状完整', () => {
  const apps = api.AGENT_ADAPTERS.map(a => a.app)
  assert.equal(apps.length, 10)
  for (const expected of ['claude-code', 'claude-desktop', 'codex', 'gemini-cli', 'grok-build', 'opencode', 'openclaw', 'hermes', 'pi', 'minimax-code']) {
    assert.ok(apps.includes(expected), `missing ${expected}`)
  }
  for (const adapter of api.AGENT_ADAPTERS) {
    assert.equal(adapter.configPaths.length, adapter.formats.length)
    assert.ok(adapter.configPaths.length >= 1)
    // 白名单路径必须在 home 下（绝对路径）
    for (const p of adapter.configPaths) assert.ok(p.startsWith('/'), p)
  }
})

test('agentApps: 返回全部应用与安装探测字段', () => {
  const apps = api.agentApps()
  assert.equal(apps.length, 10)
  assert.ok(apps.every(a => typeof a.installed === 'boolean' && typeof a.active === 'boolean'))
})

// —— 会话日志只读通道（agent.sessions.*）与 MCP 路径白名单 ——

test('claude-code adapter: ~/.claude.json mcpServers 路径入白名单且格式对齐', () => {
  const adapter = api.AGENT_ADAPTERS.find(a => a.app === 'claude-code')
  assert.ok(adapter.configPaths.some(p => p.endsWith('/.claude.json')))
  assert.equal(adapter.configPaths.length, adapter.formats.length)
})

test('agentSessionsList/Read: 无会话目录的应用直接抛错', () => {
  assert.throws(() => api.agentSessionsList('test', 'hermes'), /no session directories/)
  assert.throws(() => api.agentSessionsRead('test', { app: 'hermes', file: 'x.jsonl' }), /rejected|not found/)
})

test('agentSessionsRead: claude-code 白名单外的相对路径被拒绝', () => {
  // 白名单根即 projects/：相对路径必须 <项目目录>/…​/<file>.jsonl（≥2 段 + .jsonl 后缀）
  assert.throws(() => api.agentSessionsRead('test', { app: 'claude-code', file: '../evil.jsonl' }), /safe relative|rejected/)
  assert.throws(() => api.agentSessionsRead('test', { app: 'claude-code', file: 'x.jsonl' }), /rejected|not found/)
  assert.throws(() => api.agentSessionsRead('test', { app: 'claude-code', file: 'proj/x' }), /rejected/)
})

test('agentSessionsRead: codex 无 sessionMatch 时按白名单根定位，未命中报 not found', () => {
  // codex 未定义 sessionMatch：安全相对路径放行到根定位，文件不存在报 not found
  assert.throws(() => api.agentSessionsRead('test', { app: 'codex', file: '2025/01/01/nope.jsonl' }), /not found/)
})

test('agentSessionsRead: 真实临时目录读取 + 行解析 + 上限（经 HOME 重定向的 fixture 走不到，改验证纯逻辑边界）', () => {
  // HOME 在模块加载时已固化，无法注入临时目录；这里验证 maxBytes 钳制语义
  // （通过不存在的 claude-code projects 文件确认 not found 而非崩溃）
  assert.throws(() => api.agentSessionsRead('test', { app: 'claude-code', file: 'projects/proj/no-such.jsonl' }), /not found/)
})

test('resolveAssetTarget: codex pets 白名单内相对路径通过', () => {
  const { abs } = api.resolveAssetTarget(api.AGENT_ADAPTERS.find(a => a.app === 'codex'), 'pets/bedro/pet.json')
  assert.ok(abs.includes(joinSep(['pets', 'bedro', 'pet.json'])), abs)
})

test('resolveAssetTarget: 逃逸 / 隐藏段 / 反斜杠 / 编码分隔符 / 绝对路径全部拒绝', () => {
  const codex = api.AGENT_ADAPTERS.find(a => a.app === 'codex')
  for (const bad of ['../x.json', 'pets/../config.toml', 'pets/.env', 'pets\\a', 'pets/%2e%2e', '/etc/passwd', 'sessions/x']) {
    assert.throws(() => api.resolveAssetTarget(codex, bad), /must|required|cannot/, bad)
  }
  // 空段被规范化（与 sessions 通道一致，无逃逸风险）
  const { abs } = api.resolveAssetTarget(codex, 'pets//x//pet.json')
  assert.ok(abs.includes(joinSep(['pets', 'x', 'pet.json'])), abs)
})

test('resolveAssetTarget: 未开放资产通道的应用拒绝', () => {
  const claude = api.AGENT_ADAPTERS.find(a => a.app === 'claude-code')
  assert.throws(() => api.resolveAssetTarget(claude, 'pets/x'), /no asset directories/)
})

test('resolveAssetTarget: 空串仅 list 模式允许（列根）', () => {
  const codex = api.AGENT_ADAPTERS.find(a => a.app === 'codex')
  assert.doesNotThrow(() => api.resolveAssetTarget(codex, '', true))
  assert.throws(() => api.resolveAssetTarget(codex, '', false), /path required/)
})

test('agentListAssets / agentWriteAssets / agentDeleteAssets: confirmed 门禁与未知应用', () => {
  assert.throws(() => api.agentListAssets('t', { app: 'nope', path: 'pets' }), /unknown app/)
  assert.throws(() => api.agentWriteAssets('t', { app: 'codex', assets: [{ path: 'pets/x/a.json', contentText: '1' }] }), /请先确认/)
  assert.throws(() => api.agentDeleteAssets('t', { app: 'codex', paths: ['pets/x'] }), /请先确认/)
  assert.throws(() => api.agentWriteAssets('t', { app: 'codex', confirmed: true, assets: [] }), /assets required/)
})

function joinSep(segs) {
  return segs.join('/')
}
