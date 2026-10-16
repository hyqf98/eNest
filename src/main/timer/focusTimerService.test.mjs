import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const bundle = await build({
  entryPoints: [join(root, 'src/main/timer/focusTimerService.ts')],
  tsconfig: join(root, 'tsconfig.node.json'),
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'paths',
      setup(b) {
        b.onResolve({ filter: /pathsService$/ }, () => ({
          path: 'paths',
          namespace: 'test',
        }))
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents:
            'export const getAppPaths = () => ({data:process.env.ENEST_FOCUS_TEST_ROOT})',
        }))
      },
    },
  ],
})
const api = await import(
  'data:text/javascript;base64,' +
    Buffer.from(bundle.outputFiles[0].text).toString('base64')
)
let now, poll, events, path
const id = 'com.github.eNest.pomodoro'
test.beforeEach(async (t) => {
  path = await mkdtemp(join(tmpdir(), 'enest-focus-'))
  process.env.ENEST_FOCUS_TEST_ROOT = path
  now = 1800000000000
  events = []
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setInterval', (fn) => {
    poll = fn
    return { unref() {} }
  })
  t.mock.method(globalThis, 'clearInterval', () => {})
  await api.initFocusTimers((event) => events.push(event))
})
test.afterEach(async () => {
  await api.shutdownFocusTimers()
  await rm(path, { recursive: true, force: true })
  delete process.env.ENEST_FOCUS_TEST_ROOT
})
test('后台计时、自然完成只结算一次，跳过不计数', async () => {
  await api.startFocusTimer(id, { focusMin: 1, autoStart: false })
  now += 60000
  poll()
  poll()
  let snapshot = api.getFocusTimer(id)
  assert.equal(snapshot.records.length, 1)
  assert.equal(snapshot.records[0].counted, true)
  assert.equal(snapshot.state.phase, 'break')
  assert.equal(snapshot.state.status, 'paused')
  await api.resumeFocusTimer(id)
  now += 3000
  snapshot = await api.skipFocusTimer(id)
  assert.equal(snapshot.records.length, 2)
  assert.equal(snapshot.records[0].outcome, 'skipped')
  assert.equal(snapshot.records[0].counted, false)
  assert.equal(events.filter((e) => e.type === 'notify').length, 1)
})
test('退出保留剩余时长，重启暂停而不补算离线时间', async () => {
  await api.startFocusTimer(id, { focusMin: 25, task: '完成报告' })
  now += 120000
  await api.shutdownFocusTimers()
  const saved = JSON.parse(
    await readFile(join(path, 'focus-timers-v1.json'), 'utf8'),
  )
  assert.equal(saved.timers[id].state.remainingMs, 23 * 60000)
  now += 3600000
  await api.initFocusTimers((event) => events.push(event))
  const s = api.getFocusTimer(id).state
  assert.equal(s.status, 'paused')
  assert.equal(s.remainingMs, 23 * 60000)
  assert.equal(s.options.task, '完成报告')
  await api.resumeFocusTimer(id)
  assert.equal(api.getFocusTimer(id).state.deadline, now + 23 * 60000)
})
test('睡眠跨过多个阶段只结算一段，下一段暂停', async () => {
  await api.startFocusTimer(id, { focusMin: 1, breakMin: 1, autoStart: true })
  now += 20 * 60000
  poll()
  const snapshot = api.getFocusTimer(id)
  assert.equal(snapshot.records.length, 1)
  assert.equal(snapshot.state.phase, 'break')
  assert.equal(snapshot.state.status, 'paused')
})
test('记录编辑隔离插件；停用停止计时，未完成不计数', async () => {
  await api.startFocusTimer(id, { focusMin: 1 })
  now += 10000
  let s = await api.stopFocusTimer(id)
  assert.equal(s.state.status, 'idle')
  assert.equal(s.records[0].counted, false)
  const record = s.records[0]
  await api.updateFocusTimerRecord(id, record.id, {
    task: '校正任务',
    durationMs: 8000,
    counted: true,
  })
  s = api.getFocusTimer(id)
  assert.equal(s.records[0].task, '校正任务')
  assert.equal(s.records[0].counted, false)
  await assert.rejects(
    api.updateFocusTimerRecord('other', record.id, { deleted: true }),
    /不存在/,
  )
  await api.updateFocusTimerRecord(id, record.id, { deleted: true })
  assert.equal(api.getFocusTimer(id).records.length, 0)
})
test('短周期与长休息明确分流，正常到期可自动开始', async () => {
  await api.startFocusTimer(id, {
    focusMin: 1,
    breakMin: 1,
    longBreakEvery: 2,
    longBreakMin: 2,
    autoStart: true,
  })
  // Sample every second to distinguish normal ticking from sleep.
  for (let i = 0; i < 60; i++) {
    now += 1000
    await poll()
  }
  let s = api.getFocusTimer(id)
  assert.equal(s.state.phase, 'break')
  assert.equal(s.state.status, 'running')
  await api.skipFocusTimer(id)
  await api.resumeFocusTimer(id)
  for (let i = 0; i < 60; i++) {
    now += 1000
    await poll()
  }
  s = api.getFocusTimer(id)
  assert.equal(s.state.phase, 'longBreak')
  assert.equal(s.state.remainingMs, 120000)
})

test('信号退出同步保存，卸载清理状态与历史', async () => {
  await api.startFocusTimer(id, { focusMin: 25 })
  now += 30000
  api.shutdownFocusTimersSync()
  const saved = JSON.parse(
    await readFile(join(path, 'focus-timers-v1.json'), 'utf8'),
  )
  assert.equal(saved.timers[id].state.status, 'paused')
  assert.equal(saved.timers[id].state.remainingMs, 24.5 * 60000)
  await api.clearFocusTimer(id)
  const cleared = JSON.parse(
    await readFile(join(path, 'focus-timers-v1.json'), 'utf8'),
  )
  assert.equal(id in cleared.timers, false)
})
test('损坏计时文件保留原文，不用空数据覆盖', async () => {
  const target = join(path, 'focus-timers-v1.json')
  await writeFile(target, '{broken', 'utf8')
  await assert.rejects(
    api.initFocusTimers(() => {}),
    /读取专注计时记录失败/,
  )
  await assert.rejects(api.startFocusTimer(id, {}), /尚未就绪/)
  await api.shutdownFocusTimers()
  assert.equal(await readFile(target, 'utf8'), '{broken')
})
