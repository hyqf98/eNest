import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'
const open = url => {
  const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 })
  let seq = 0; const pending = new Map()
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  return { ws, ready, q: expression => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })) }).then(r => r.result?.exceptionDetails ? 'EXC:' + (r.result.exceptionDetails.exception?.description ?? '').slice(0,150) : r.result?.result?.value), shot: () => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } })) }).then(r => r.result?.data) }
}
const targets = await (await fetch('http://127.0.0.1:9331/json/list')).json()
const sh = open(targets.find(t => t.url === 'http://127.0.0.1:27319/').webSocketDebuggerUrl); await sh.ready
// 先切回主题 tab 再测
const home = targets.find(t => t.url.includes('home.html'))
const hw = open(home.webSocketDebuggerUrl); await hw.ready
await hw.q(`(() => { const tab=[...document.querySelectorAll('button')].find(el=>(el.textContent||'').trim()==='主题'); tab?.click(); return !!tab })()`)
await sleep(1500)
console.log('TITLES:', await hw.q(`(() => {
  const secs = [...document.querySelectorAll('[data-settings-section]')].filter(s => s.getBoundingClientRect().height > 0).map(s => {
    const h2 = s.querySelector('h2')
    const rects = h2 ? (() => { const r = document.createRange(); r.selectNodeContents(h2); return r.getClientRects().length })() : 0
    return { id: s.dataset.settingsSection, h2Text: h2?.textContent.trim().slice(0,16), h2H: h2 ? Math.round(h2.getBoundingClientRect().height) : 0, h2Lines: rects }
  })
  return JSON.stringify({ vw: document.documentElement.clientWidth, secs })
})()`))
const s = await hw.shot()
if (s) { const { writeFileSync } = await import('node:fs'); writeFileSync('/tmp/enest-wrap.png', Buffer.from(s, 'base64')); console.log('shot saved') }
hw.ws.close(); sh.ws.close(); process.exit(0)
