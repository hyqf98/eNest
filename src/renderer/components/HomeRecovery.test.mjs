import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('./HomeRecovery.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText

function fixture() {
  let cursor = 0, effect, listener, readResolve, readReject, retryResolve, retryReject
  const values = [], calls = []
  const read = new Promise((resolve, reject) => { readResolve = resolve; readReject = reject })
  const retry = new Promise((resolve, reject) => { retryResolve = resolve; retryReject = reject })
  const jsx = (type, props) => ({ type, props })
  const imports = {
    react: {
      useState(initial) {
        const index = cursor++
        if (values.length <= index) values[index] = initial
        return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next }]
      },
      useEffect: next => { effect = next },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@renderer/components/ui/Button': { Button: 'button' },
    '@renderer/services/shellApi': { shellApi: {
      onEvent: next => { calls.push('subscribe'); listener = next; return () => { listener = null } },
      getHomeState: () => { calls.push('read'); return read }, retryHome: () => retry,
    } },
    '@renderer/stores/shellStore': { useShellStore: { getState: () => ({ setSettingsTab: tab => calls.push(tab), setView: view => calls.push(view) }) } },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(id => imports[id], module, module.exports)
  const render = () => { cursor = 0; return module.exports.HomeRecovery() }
  render()
  const dispose = effect()
  return { render, dispose, calls, readResolve, readReject, retryResolve, retryReject,
    emit: state => listener?.({ type: 'home-status', state }),
  }
}

test('idle, loading and ready have no recovery UI; only actual failure offers recovery', () => {
  const f = fixture()
  try {
    assert.deepEqual(f.calls, ['subscribe', 'read'])
    for (const status of ['idle', 'loading', 'ready']) {
      f.emit({ status, generation: 1 })
      assert.equal(f.render(), null)
    }
    f.emit({ status: 'error', generation: 1, message: 'provider failed' })
    const tree = f.render()
    assert.equal(tree.props.children[1].props.children, '首页暂时无法显示')
    assert.equal(tree.props.children[2].props.children, 'provider failed')
    tree.props.children[3].props.children[1].props.onClick()
    assert.deepEqual(f.calls.slice(-2), ['appearance', 'settings'])
  } finally { f.dispose() }
})

test('retry retains an actionable failure panel and a failed old read cannot override newer status', async () => {
  const f = fixture()
  try {
    f.emit({ status: 'ready', generation: 2 })
    f.readReject(Error('old read failed'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.render(), null)
    f.emit({ status: 'error', generation: 2 })
    const retried = f.render().props.children[3].props.children[0].props.onClick()
    f.emit({ status: 'loading', generation: 3 })
    assert.equal(f.render().props['aria-busy'], true)
    assert.equal(f.render().props.children[3].props.children[0].props.disabled, true)
    f.retryReject(Error('retry failed'))
    await retried
    assert.equal(f.render().props['aria-busy'], false)
    assert.equal(f.render().props.children[3].props.children[0].props.disabled, false)
    f.emit({ status: 'ready', generation: 4 })
    assert.equal(f.render(), null)
  } finally { f.dispose() }
})
