import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../../../src/main/window/windowShape.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })

function fixture(platform, wayland = false) {
  const display = { scaleFactor: 1 }
  const screen = Object.assign(new EventEmitter(), { getDisplayMatching: () => display })
  const state = { maximized: false, fullscreen: false, snapped: false }
  const shapes = [], radii = []
  const bounds = { x: 0, y: 0, width: 1200, height: 800 }
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isMinimized: () => false, isMaximized: () => state.maximized,
    isFullScreen: () => state.fullscreen, ...(platform === 'win32' ? { isSnapped: () => state.snapped } : {}), getBounds: () => bounds,
    setShape(rects) { shapes.push(structuredClone(rects)); win.emit('resize') }
  })
  const exports = {}
  vm.runInNewContext(outputText, { exports, process: { platform }, require: id => id === 'electron' ? { screen } : { isWaylandWindowSystem: () => wayland } })
  const clip = platform === 'linux' ? { setBackgroundBlur() {}, setBorderRadius: radius => radii.push(radius) } : undefined
  exports.trackWindowShape(win, 12, clip)
  return { win, state, screen, display, bounds, shapes, radii }
}

test('Windows rounds the floating window once per size and DPI and releases the region when tiled', () => {
  const { win, state, screen, display, bounds, shapes } = fixture('win32')
  const covers = (left, top) => shapes.at(-1).some(({ x, y, width, height }) => x <= left && left < x + width && y <= top && top < y + height)
  assert.equal(covers(0, 0), false)
  assert.equal(covers(600, 0), true)
  assert.equal(covers(0, 400), true)
  win.emit('show'); win.emit('moved')
  assert.equal(shapes.length, 1)
  bounds.width += 100; win.emit('resize')
  assert.equal(covers(1299, 400), true)
  display.scaleFactor = 1.5; screen.emit('display-metrics-changed')
  assert.equal(shapes.length, 3)
  for (const [mode, enter, leave] of [['maximized', 'maximize', 'unmaximize'], ['fullscreen', 'enter-full-screen', 'leave-full-screen'], ['snapped', 'moved', 'resize']]) {
    state[mode] = true; win.emit(enter)
    assert.deepEqual(shapes.at(-1), [])
    state[mode] = false; win.emit(leave)
    assert.equal(covers(0, 400), true)
    assert.equal(covers(0, 0), false)
  }
  win.emit('closed')
  assert.equal(screen.listenerCount('display-metrics-changed'), 0)
})

test('macOS keeps system window corners without applying Windows regions', () => {
  const { win, screen, shapes } = fixture('darwin')
  win.emit('resize'); screen.emit('display-metrics-changed')
  assert.deepEqual(shapes, [])
  assert.equal(screen.listenerCount('display-metrics-changed'), 0)
})

test('Linux clips the entire content tree; only X11 additionally installs a native region', () => {
  for (const wayland of [false, true]) {
    const { win, state, screen, shapes, radii, bounds } = fixture('linux', wayland)
    assert.deepEqual(radii, [12])
    assert.equal(shapes.length, wayland ? 0 : 1)
    state.maximized = true; win.emit('maximize')
    if (!wayland) assert.deepEqual(shapes.at(-1), [{ ...bounds }])
    state.maximized = false; win.emit('unmaximize')
    win.emit('resize'); win.emit('show')
    assert.deepEqual(radii, [12, 0, 12])
    assert.equal(shapes.length, wayland ? 0 : 3)
    win.emit('closed')
    assert.equal(screen.listenerCount('display-metrics-changed'), 0)
  }
})
