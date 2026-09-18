# 示例插件

本页给出 **可直接复制** 的完整插件：每个示例都包含 `plugin.json` + `index.html`，创建目录、放入两个文件、在开发者控制台加载即可运行。

仓库 `plugins-samples/` 另有一组示例，见文末一览。

---

## 1. 轻清单（storage.local + Toast）

演示：持久化待办、Tab 标题同步、角标、应用内 Toast。

**plugin.json**

```json
{
  "id": "com.example.todo",
  "name": "轻清单",
  "version": "1.0.0",
  "main": "index.html",
  "permissions": [
    "ui.setTitle",
    "ui.setBadge",
    "ui.toast",
    "storage.local"
  ]
}
```

**index.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>轻清单</title>
  <style>
    :root {
      --bg: #f4f5f7; --surface: #fff; --text: #0f1420;
      --text-2: #5c6578; --border: rgba(15,23,42,.08); --accent: #1a1f2e;
      --ok: #0d9f6e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      background: var(--bg); color: var(--text);
      font: 15px/1.6 Inter, "PingFang SC", system-ui, sans-serif;
      padding: 32px 20px;
    }
    .wrap { max-width: 480px; margin: 0 auto; }
    h1 { font-size: 1.4rem; margin: 0 0 16px; letter-spacing: -.03em; }
    .row { display: flex; gap: 8px; margin-bottom: 16px; }
    input[type=text] {
      flex: 1; padding: 10px 12px; border-radius: 10px;
      border: 1px solid var(--border); background: var(--surface);
      color: var(--text); font: inherit; outline: none;
    }
    input[type=text]:focus { border-color: var(--ok); }
    button {
      padding: 10px 16px; border-radius: 10px; border: none;
      background: var(--accent); color: var(--bg); font: inherit;
      font-weight: 600; cursor: pointer;
    }
    button.ghost {
      background: transparent; color: var(--text-2);
      border: 1px solid var(--border);
    }
    ul { list-style: none; padding: 0; margin: 0; }
    li {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; margin-bottom: 8px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px;
    }
    li.done span { text-decoration: line-through; color: var(--text-2); }
    li span { flex: 1; }
    .empty { color: var(--text-2); font-size: 13px; padding: 8px 2px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>轻清单</h1>
    <div class="row">
      <input id="input" type="text" placeholder="添加一项…" />
      <button id="add">添加</button>
    </div>
    <ul id="list"></ul>
    <p class="empty" id="empty">暂无待办</p>
    <div class="row">
      <button class="ghost" id="clear">清除已完成</button>
    </div>
  </div>

  <script>
    const api = window.enest // zapi 为 @deprecated 别名，计划 v2 移除
    const KEY = 'todos'
    let todos = []

    const $ = (id) => document.getElementById(id)

    function render() {
      $('list').innerHTML = ''
      $('empty').style.display = todos.length ? 'none' : 'block'
      for (const [i, t] of todos.entries()) {
        const li = document.createElement('li')
        if (t.done) li.className = 'done'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = t.done
        cb.onchange = async () => {
          todos[i].done = cb.checked
          await persist()
          render()
        }
        const span = document.createElement('span')
        span.textContent = t.text
        const del = document.createElement('button')
        del.className = 'ghost'
        del.textContent = '删除'
        del.onclick = async () => {
          todos.splice(i, 1)
          await persist()
          render()
        }
        li.append(cb, span, del)
        $('list').appendChild(li)
      }
      syncChrome()
    }

    async function persist() {
      await api?.storage.set(KEY, todos)
    }

    async function syncChrome() {
      const left = todos.filter((t) => !t.done).length
      await api?.ui.setTitle(`轻清单 · ${left}`)
      await api?.ui.setBadge(left || '')
    }

    async function add() {
      const text = $('input').value.trim()
      if (!text) return
      todos.push({ text, done: false })
      $('input').value = ''
      await persist()
      await api?.ui.toast({ message: '已添加', type: 'success' })
      render()
    }

    $('add').onclick = add
    $('input').onkeydown = (e) => { if (e.key === 'Enter') add() }
    $('clear').onclick = async () => {
      todos = todos.filter((t) => !t.done)
      await persist()
      await api?.ui.toast({ message: '已清除完成项', type: 'info' })
      render()
    }

    // 启动：读取持久化数据
    ;(async () => {
      todos = (await api?.storage.get(KEY)) || []
      render()
    })()
  </script>
</body>
</html>
```

**要点**

- `storage.local` 关 Tab 后仍在，重开插件数据不丢
- `ui.setTitle` / `ui.setBadge` 让壳子 Tab 与内部状态一致
- `ui.toast` 用壳子统一轻提示，不要自绘 snackbar 风格碎片

---

## 2. 主题感知面板（theme + 主题包注册）

演示：读 Token、跟随主题、注册主题包到壳子设置。

**plugin.json**

```json
{
  "id": "com.example.theme-lab",
  "name": "主题实验室",
  "version": "1.0.0",
  "main": "index.html",
  "permissions": ["ui.setTitle", "ui.toast"],
  "ui": {
    "chrome": "minimal",
    "themeAware": true,
    "background": "opaque",
    "preferredColorScheme": "auto"
  }
}
```

**index.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>主题实验室</title>
  <style>
    /* 兜底 Token；壳子 themeAware 注入后会被覆盖 */
    :root {
      --bg: #f4f5f7; --surface: #fff; --surface-2: #f0f2f5;
      --text: #0f1420; --text-2: #5c6578;
      --border: rgba(15,23,42,.08); --accent: #1a1f2e;
      --ok: #0d9f6e; --ok-soft: rgba(13,159,110,.1); --danger: #e11d48;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; padding: 28px 20px;
      background: var(--bg); color: var(--text);
      font: 15px/1.65 Inter, "PingFang SC", system-ui, sans-serif;
    }
    .wrap { max-width: 560px; margin: 0 auto; }
    h1 { font-size: 1.35rem; margin: 0 0 6px; letter-spacing: -.03em; }
    .mode {
      display: inline-block; padding: 2px 10px; border-radius: 999px;
      font-size: 12px; font-weight: 650;
      color: var(--accent); background: var(--ok-soft);
      margin-bottom: 18px;
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 14px 0; }
    .swatch {
      border-radius: 10px; border: 1px solid var(--border);
      padding: 12px; background: var(--surface); font-size: 12px;
    }
    .swatch i {
      display: block; height: 36px; border-radius: 6px; margin-bottom: 8px;
      border: 1px solid var(--border);
    }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 14px 16px; margin: 12px 0;
      color: var(--text-2); font-size: 13.5px;
    }
    button {
      padding: 10px 16px; border-radius: 10px; border: none;
      background: var(--accent); color: var(--bg);
      font: inherit; font-weight: 600; cursor: pointer; margin-right: 8px;
    }
    pre {
      background: var(--surface-2); color: var(--text-2);
      padding: 12px; border-radius: 10px; font-size: 12px;
      overflow: auto; max-height: 180px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>主题实验室</h1>
    <div class="mode" id="mode">—</div>

    <div class="grid" id="swatches"></div>

    <div class="card">
      这张卡片使用 <code>--surface</code> / <code>--border</code> / <code>--text-2</code>，
      切换壳子主题时应立即跟随。
    </div>

    <p>
      <button id="pack">注册「薄荷森林」主题包</button>
      <button id="read" style="background:transparent;color:var(--text-2);border:1px solid var(--border)">刷新 Token</button>
    </p>

    <pre id="dump">loading…</pre>
  </div>

  <script>
    const api = window.enest // zapi 为 @deprecated 别名，计划 v2 移除
    const KEYS = [
      '--bg', '--surface', '--surface-2', '--surface-3',
      '--text', '--text-2', '--text-3',
      '--accent', '--ok', '--danger'
    ]

    function paint(mode, tokens) {
      document.getElementById('mode').textContent = `mode: ${mode}`
      const box = document.getElementById('swatches')
      box.innerHTML = ''
      for (const k of KEYS) {
        const v = tokens[k] || ''
        const d = document.createElement('div')
        d.className = 'swatch'
        d.innerHTML = `<i style="background:${v}"></i>${k}`
        box.appendChild(d)
      }
      document.getElementById('dump').textContent =
        JSON.stringify({ mode, tokens }, null, 2)
    }

    async function refresh() {
      const { mode, tokens } = await api.theme.getTokens()
      paint(mode, tokens)
    }

    api?.ui.setTitle('主题实验室')
    api?.ui.onThemeChange(({ mode, tokens }) => paint(mode, tokens))
    refresh()

    document.getElementById('read').onclick = refresh

    document.getElementById('pack').onclick = async () => {
      await api.theme.register({
        id: 'com.example.mint-forest',
        name: '薄荷森林',
        mode: 'dark',
        tokens: {
          '--bg': '#0a1f1c',
          '--surface': '#0f2924',
          '--surface-2': '#14352f',
          '--surface-3': '#1a3f38',
          '--text': '#e8fff8',
          '--text-2': '#9ccfc0',
          '--text-3': '#6a9a8c',
          '--accent': '#2dd4a8',
          '--border': 'rgba(255,255,255,0.08)',
          '--border-strong': 'rgba(255,255,255,0.14)',
          '--ok': '#3dd68c',
          '--danger': '#ff7a8e'
        },
        background: {
          type: 'color',
          value: 'linear-gradient(160deg,#0a1f1c,#134e4a)',
          opacity: 0.92
        }
      })
      api.ui.toast({
        message: '已注册，请到 设置 → 主题 选择「薄荷森林」',
        type: 'success'
      })
    }
  </script>
</body>
</html>
```

**要点**

- `theme.getTokens()` 与 `ui.onThemeChange` 覆盖首屏 + 运行时
- `theme.register` 后壳子设置页下拉即时出现，无需重启
- CSS 里保留兜底变量，避免壳子未注入时白屏

---

## 3. 沉浸式 Canvas（chrome=none + 透明底）

演示：无插件条、透明背景、主题感知动画、生命周期 pause/resume。

**plugin.json**

```json
{
  "id": "com.example.particles",
  "name": "粒子",
  "version": "1.0.0",
  "main": "index.html",
  "permissions": ["ui.setTitle"],
  "ui": {
    "chrome": "none",
    "themeAware": true,
    "background": "transparent",
    "preferredColorScheme": "auto"
  }
}
```

**index.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>粒子</title>
  <style>
    :root { --text: #f2f4f8; --accent: #5b8cff; --bg: #0a0c10; }
    html, body {
      margin: 0; width: 100%; height: 100%; overflow: hidden;
      background: transparent !important;
      font-family: Inter, "PingFang SC", system-ui, sans-serif;
      color: var(--text);
    }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    .hud {
      position: fixed; left: 18px; bottom: 18px;
      padding: 10px 14px; border-radius: 12px; font-size: 12px;
      background: color-mix(in srgb, var(--bg) 55%, transparent);
      border: 1px solid color-mix(in srgb, var(--text) 14%, transparent);
      backdrop-filter: blur(10px); pointer-events: none;
      max-width: 260px; line-height: 1.5;
    }
    .hud strong { display: block; font-size: 13px; margin-bottom: 2px; }
  </style>
</head>
<body>
  <canvas id="c"></canvas>
  <div class="hud">
    <strong>粒子 · chrome=none</strong>
    透明底 + 主题感知 · 切 Tab 自动暂停
  </div>

  <script>
    const api = window.enest // zapi 为 @deprecated 别名，计划 v2 移除
    const canvas = document.getElementById('c')
    const ctx = canvas.getContext('2d')

    let accent = '#5b8cff'
    let dpr = Math.max(1, window.devicePixelRatio || 1)
    let W = 0, H = 0
    const N = 80
    const parts = []
    let raf = 0

    function applyTokens(tokens) {
      accent = tokens['--accent'] || accent
    }

    function resize() {
      dpr = Math.max(1, window.devicePixelRatio || 1)
      W = canvas.clientWidth
      H = canvas.clientHeight
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    window.addEventListener('resize', resize)
    resize()

    for (let i = 0; i < N; i++) {
      parts.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.6,
        vy: (Math.random() - 0.5) * 0.6,
        r: 1.5 + Math.random() * 2.5
      })
    }

    function frame() {
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = accent
      ctx.globalAlpha = 0.75
      for (const p of parts) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0 || p.x > W) p.vx *= -1
        if (p.y < 0 || p.y > H) p.vy *= -1
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }
      // 连线
      ctx.globalAlpha = 0.18
      ctx.strokeStyle = accent
      ctx.lineWidth = 1
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const a = parts[i], b = parts[j]
          const dx = a.x - b.x, dy = a.y - b.y
          const d2 = dx * dx + dy * dy
          if (d2 < 10000) {
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(frame)
    }

    function start() { if (!raf) raf = requestAnimationFrame(frame) }
    function stop() { cancelAnimationFrame(raf); raf = 0 }

    api?.ui.setTitle('粒子')
    api?.theme.getTokens().then(({ tokens }) => applyTokens(tokens))
    api?.ui.onThemeChange(({ tokens }) => applyTokens(tokens))
    api?.onEnter(start)
    api?.onOut(stop)
    api?.onDestroy(stop)

    // 兜底：无 API 时也能跑（本地浏览器预览）
    if (!api) start()
  </script>
</body>
</html>
```

**要点**

- `background: transparent` + `body` 透明 + `clearRect`，三者缺一不可
- `onOut` 停 rAF，避免后台 Tab 白耗电
- 颜色读 `--accent`，跟随壳子主题

---

## 4. 系统集成（剪贴板 + 通知 + 外链 + 设置）

演示：读剪贴板、写剪贴板、系统通知、打开外链、设置面板。

**plugin.json**

```json
{
  "id": "com.example.tools",
  "name": "小工具箱",
  "version": "1.0.0",
  "main": "index.html",
  "permissions": [
    "clipboard.read",
    "clipboard.write",
    "shell.openExternal",
    "notify",
    "ui.toast",
    "ui.setTitle",
    "settings.register",
    "storage.local"
  ]
}
```

**index.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>小工具箱</title>
  <style>
    :root {
      --bg: #f4f5f7; --surface: #fff; --text: #0f1420; --text-2: #5c6578;
      --border: rgba(15,23,42,.08); --accent: #1a1f2e; --ok: #0d9f6e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 28px 20px; min-height: 100vh;
      background: var(--bg); color: var(--text);
      font: 15px/1.65 Inter, "PingFang SC", system-ui, sans-serif;
    }
    .wrap { max-width: 520px; margin: 0 auto; display: grid; gap: 10px; }
    h1 { font-size: 1.3rem; margin: 0 0 8px; letter-spacing: -.03em; }
    textarea {
      width: 100%; min-height: 90px; resize: vertical;
      padding: 12px; border-radius: 10px; border: 1px solid var(--border);
      background: var(--surface); color: var(--text); font: inherit;
    }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button {
      padding: 9px 14px; border-radius: 10px; border: 1px solid var(--border);
      background: var(--surface); color: var(--text); font: inherit;
      font-weight: 550; cursor: pointer;
    }
    button.primary { background: var(--accent); color: var(--bg); border: none; }
    .hint { color: var(--text-2); font-size: 13px; }
    #who { font-size: 12px; color: var(--text-2); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>小工具箱 <span id="who"></span></h1>
    <textarea id="box" placeholder="剪贴板内容会出现在这里"></textarea>
    <div class="actions">
      <button id="paste" class="primary">读剪贴板</button>
      <button id="copy">写入剪贴板</button>
      <button id="ping">系统通知</button>
      <button id="toast">应用内 Toast</button>
      <button id="link">打开官网</button>
    </div>
    <p class="hint" id="greet">称呼：—</p>
  </div>

  <script>
    const api = window.enest // zapi 为 @deprecated 别名，计划 v2 移除
    const $ = (id) => document.getElementById(id)

    api?.ui.setTitle('小工具箱')
    $('who').textContent = api ? api.getPluginId() : '(no api)'

    // 注册设置（壳子 设置 → 插件）
    api?.settings.register({
      id: 'tools.prefs',
      title: '小工具箱',
      items: [
        { key: 'greeting', type: 'text', label: '称呼', default: '朋友' }
      ]
    })

    async function loadGreeting() {
      const g = (await api?.settings.get('greeting')) || '朋友'
      $('greet').textContent = '称呼：' + g
    }
    loadGreeting()
    // 用户可能在壳子设置页改值；切回插件时 onEnter 再读一次
    api?.onEnter(loadGreeting)

    $('paste').onclick = async () => {
      try {
        $('box').value = await api.clipboard.readText()
        api.ui.toast({ message: '已读取剪贴板', type: 'info' })
      } catch (e) {
        api.ui.toast({ message: e.message, type: 'error' })
      }
    }

    $('copy').onclick = async () => {
      try {
        await api.clipboard.writeText($('box').value)
        api.ui.toast({ message: '已复制', type: 'success' })
      } catch (e) {
        api.ui.toast({ message: e.message, type: 'error' })
      }
    }

    $('ping').onclick = () =>
      api.notify({ title: '小工具箱', body: '来自 eNest 插件的系统通知' })

    $('toast').onclick = () =>
      api.ui.toast({ message: '这是壳子 Toast', type: 'success' })

    $('link').onclick = async () => {
      try {
        await api.shell.openExternal('https://github.com/')
      } catch (e) {
        api.ui.toast({ message: e.message, type: 'error' })
      }
    }
  </script>
</body>
</html>
```

**要点**

- `settings.register` 后 `settings.get/set` 无需额外权限
- `notify` vs `ui.toast`：系统级 vs 应用内
- `shell.openExternal` 只接受 http(s)

---

## 仓库示例一览

```bash
npm install
npm run dev
```

壳子左下角 →「开发者」→「加载本地目录」→ 选中对应目录。

| 目录 | 演示点 |
|------|--------|
| `plugins-samples/hello` | 最小插件：标题、通知 |
| `plugins-samples/todo` | 本地待办 + `storage.local` |
| `plugins-samples/clipboard` | 剪贴板读写 |
| `plugins-samples/color` | 取色 / UI 交互 |
| `plugins-samples/json` | 工具型单页 |
| `plugins-samples/snippet` | 片段管理 |
| `plugins-samples/translate` | 翻译类示例 |
| `plugins-samples/canvas-demo` | `chrome=none` + 主题感知 + 透明底 Canvas |

以实际仓库目录为准。

---

## 从示例起步

```bash
mkdir my-plugin && cd my-plugin
# 粘贴上方任意一组 plugin.json + index.html

# 或拷贝仓库示例
cp -R ../plugins-samples/hello .
# 改 plugin.json 的 id / name，避免与内置示例冲突
```

打包：

```bash
cd my-plugin && zip -r ../my-plugin.enestplugin .
```

---

## 下一步

- [enest API](api.md) — 方法签名与权限
- [生命周期](lifecycle.md) — pause / flush 模式
- [UI 集成标准](ui-standard.md) — chrome / 主题 / 透明 / mini 小窗
