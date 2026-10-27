import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

async function bundle(entry) {
  const output = await build({ entryPoints: [entry], tsconfig: 'tsconfig.node.json', bundle: true, write: false, format: 'esm', platform: 'node' })
  return import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))
}
const resolver = await bundle('src/main/dev/devCommandResolver.ts')
const spawn = await bundle('src/main/dev/devSpawn.ts')

test('lockfile detection walks up to the workspace root and falls back to npm', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enest-resolver-'))
  try {
    const plugin = join(root, 'plugins', 'demo')
    await mkdir(plugin, { recursive: true })
    assert.equal(resolver.detectPackageManager(plugin), 'npm', '无锁文件按 npm 兜底')
    await writeFile(join(root, 'pnpm-lock.yaml'), '')
    assert.equal(resolver.detectPackageManager(plugin), 'pnpm', 'workspace 根持锁可向上识别')
    await rm(join(root, 'pnpm-lock.yaml'))
    await writeFile(join(root, 'yarn.lock'), '')
    assert.equal(resolver.detectPackageManager(plugin), 'yarn')
    await rm(join(root, 'yarn.lock'))
    await writeFile(join(root, 'package-lock.json'), '')
    assert.equal(resolver.detectPackageManager(plugin), 'npm')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('scripts fallback chain: dev → start, build → pack, none means no command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-resolver-'))
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'vite' } }))
    let plan = resolver.resolveDevCommandPlan(dir, { development: { main: 'http://127.0.0.1:5175/' } })
    assert.equal(plan.start.label, 'npm run dev')
    assert.equal(plan.devUrl, 'http://127.0.0.1:5175/')
    assert.equal(plan.build, undefined, '无 build/pack 脚本则无构建命令')
    assert.equal(plan.output, 'dist')

    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'serve .', pack: 'vite build' } }))
    plan = resolver.resolveDevCommandPlan(dir)
    assert.equal(plan.start.label, 'npm run start', 'scripts.dev 缺失回退 start')
    assert.equal(plan.build.label, 'npm run pack', 'scripts.build 缺失回退 pack')
    assert.equal(plan.devUrl, undefined, '未声明 URL 时不凭空产生 devUrl')

    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'static-html-plugin' }))
    plan = resolver.resolveDevCommandPlan(dir)
    assert.equal(plan.start, undefined, '纯静态插件不拉服务')
    assert.equal(plan.build, undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('enest section: raw command escape hatch, manager override, url precedence, output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-resolver-'))
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      scripts: { dev: 'vite', build: 'vite build' },
      enest: {
        dev: { url: 'http://127.0.0.1:5999/', command: 'deno task dev --port {port}' },
        build: { manager: 'pnpm' },
        output: 'build-out'
      }
    }))
    const plan = resolver.resolveDevCommandPlan(dir, { development: { main: 'http://127.0.0.1:1/' } })
    assert.equal(plan.devUrl, 'http://127.0.0.1:5999/', 'enest.dev.url 优先于 development.main')
    assert.equal(plan.start.kind, 'raw')
    assert.equal(plan.start.label, 'deno task dev --port {port}')
    assert.equal(plan.build.label, 'pnpm run build', '显式 manager 覆盖锁文件检测')
    assert.equal(plan.output, 'build-out')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('explicit script declaration wins over fallback order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-resolver-'))
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      scripts: { dev: 'vite', watch: 'chokidar' },
      enest: { dev: { manager: 'yarn', script: 'watch' } }
    }))
    const plan = resolver.resolveDevCommandPlan(dir)
    assert.equal(plan.start.label, 'yarn run watch')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('missing or malformed package.json degrades gracefully; malformed enest fields are ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-resolver-'))
  try {
    let plan = resolver.resolveDevCommandPlan(dir, { development: { main: 'http://127.0.0.1:5175/' } })
    assert.equal(plan.start, undefined)
    assert.equal(plan.devUrl, 'http://127.0.0.1:5175/', '无 package.json 仍可用 development.main')
    assert.equal(plan.output, 'dist')

    await writeFile(join(dir, 'package.json'), '{oops')
    plan = resolver.resolveDevCommandPlan(dir)
    assert.equal(plan.start, undefined, '畸形 JSON 视为未声明')

    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, enest: 'nope' }))
    plan = resolver.resolveDevCommandPlan(dir)
    assert.equal(plan.start.label, 'npm run dev', 'enest 段类型错误整体忽略')

    await writeFile(join(dir, 'package.json'), JSON.stringify({
      scripts: { dev: 'vite' },
      enest: { dev: { manager: 'cargo', script: 42, portArgs: '--port', env: ['PATH'] } }
    }))
    plan = resolver.resolveDevCommandPlan(dir)
    assert.equal(plan.start.label, 'npm run dev', '非法 manager/script/portArgs/env 字段静默丢弃')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('formatPortArgs renders {port} templates and defaults to vite-style args', () => {
  assert.deepEqual(spawn.formatPortArgs(undefined, 5177), ['--', '--port=5177'])
  assert.deepEqual(spawn.formatPortArgs(['-p', '{port}'], 5177), ['-p', '5177'])
})

test('buildSpawnCandidates: raw goes through the shell; script is manager-agnostic', () => {
  const raw = spawn.buildSpawnCandidates({ kind: 'raw', command: 'deno task dev', label: 'deno task dev' }, [])
  assert.equal(raw.length, 1)
  assert.equal(raw[0].command, 'deno task dev')
  assert.equal(raw[0].useShell, true)

  if (process.platform !== 'win32') {
    const script = spawn.buildSpawnCandidates(
      { kind: 'script', command: 'dev', manager: 'pnpm', label: 'pnpm run dev' },
      ['--', '--port=5177']
    )
    assert.equal(script[0].command, 'pnpm')
    assert.deepEqual(script[0].args, ['run', 'dev', '--', '--port=5177'])
    assert.equal(script[1].args[0], '-lc', 'ENOENT 时回退 login shell')
    assert.match(script[1].args[1], /pnpm run dev -- --port=5177/)
  }
})
