# 生命周期

插件在壳子中以 **原生 `WebContentsView`** 存在：创建加载 → 可见 / 切走 → 关闭销毁。切走仅 `setVisible(false)`，状态保活；但后台空闲的插件会被 **休眠（hibernate）** 销毁渲染进程、保留逻辑 Tab 与 session 快照，唤醒时重建（详见下文「休眠与驱逐」）。

---

## 状态机

```mermaid
stateDiagram-v2
    [*] --> Unloaded
    Unloaded --> Loading: openPlugin(id)
    Loading --> Active: did-finish-load
    Loading --> Unloaded: load fail / render-process-gone
    Active --> Background: 切换到其它 Tab / Quick 退场
    Background --> Active: 激活本 Tab / openPlugin(自身)
    Active --> Destroyed: closePlugin / destroyAll
    Background --> Destroyed: closePlugin / destroyAll
    Background --> Hibernated: 空闲超时 / LRU 驱逐
    Hibernated --> Loading: openPlugin(自身)（快照恢复重建）
    Destroyed --> Unloaded: 资源释放完毕（等价未加载）
```

ASCII 等价视图：

```text
                    openPlugin
   Unloaded ──────────────────► Loading
       ▲                          │
       │                 did-finish-load
       │                          ▼
       │                        Active ◄────────┐
       │                          │             │ activatePlugin(self)
       │            activatePlugin(other)       │
       │                          ▼             │
       │                      Background ───────┘
       │                        │       │
       │         closePlugin / destroyAll    空闲 3min / LRU 驱逐
       │                        ▼       ▼
       └──────────────────── Destroyed   Hibernated ──openPlugin──► Loading（重建）
```

| 状态 | 含义 | 资源占用 |
|------|------|----------|
| `Unloaded` | 未创建 View（从未打开 / 已关闭） | 无 |
| `Loading` | View 已创建，`loadURL` 进行中 | WebContents 创建中 |
| `Active` | 可见且可交互 | 完整 |
| `Background` | 已加载但 `setVisible(false)` | View / 进程保留 |
| `Hibernated` | 后台空闲被休眠：渲染进程已销毁，逻辑 Tab + session 快照保留 | 无（轻量记录） |
| `Destroyed` | 显式关闭 / 卸载 / 应用退出 | 已释放 |

> 源码位置：`src/main/plugin/PluginHost.ts` · `src/main/plugin/PluginLifecycle.ts` · `src/main/plugin/PluginSessionStore.ts` · `src/main/ipc/pluginHandlers.ts` · `src/preload/pluginPreload.ts`  
> 深度评审：`docs/engineering/LIFECYCLE_REVIEW.md`

---

## 事件时间线

```text
首次打开
  openPlugin
    → 创建 partition / View / 注入 preload
    → loadURL
    → did-finish-load
    → 主进程推送 plugin:lifecycle { event: 'enter', tabId, code?, payload? }
    → preload 派发给 onEnter 回调

切到其它 Tab
  activatePlugin(other)
    → setVisible(false)
    → plugin:lifecycle { event: 'out', isKill: false }
    → onOut
    → 启动空闲休眠计时（3 分钟无激活 → hibernate）

切回本 Tab
  activatePlugin(self) / openPlugin(self)
    → setVisible(true)
    → plugin:lifecycle { event: 'enter', ... }
    → onEnter（再次触发）

休眠 → 唤醒
  后台空闲超时 / LRU 驱逐
    → saveSessionSnapshot（sessionBag 快照落 enest.db）
    → plugin:lifecycle { event: 'destroy' }（尽力而为）
    → 销毁 View（逻辑 Tab 保留）
  再次 openPlugin(自身) / 激活
    → loadSessionSnapshot 恢复 storage.session
    → 重建 View（等价冷启动）
    → onEnter（再次触发）

关闭 Tab / 卸载 / 退出
  closePlugin
    → plugin:lifecycle { event: 'beforeClose', reason }
    → onBeforeClose（回调可返回 Promise）
    → preload 等全部返回的 Promise settle 后回 ack（主进程最多等 1500ms 超时兜底）
    → plugin:lifecycle { event: 'destroy' }
    → onDestroy（best-effort）
    → webContents.close()
    → clearPluginSession(pluginId)   // 丢弃 storage.session
    → 移除 View
```

---

## beforeClose 的 ack 语义（Promise-aware）

`onBeforeClose` 回调可以返回 Promise：**任一监听器返回 Promise，preload 就等全部 Promise settle 后再回 ack**，关闭流程随之等待。

- 回调返回 **Promise** → 等其 settle 再 ack（本地防悬挂 cap 2s，仅兜底）；
- 纯同步回调 / 无监听器 → 延迟约 50ms（给同步 flush 留余量）再 ack；
- 主进程最多等 **1500ms**，超时直接销毁——超长异步操作请自行拆分。

```js
enest.onBeforeClose(async ({ reason }) => {
  // 返回 Promise：壳子会等这里完成（≤1500ms）后再销毁
  await flushDraftToStorage()
})
```

---

## 休眠与驱逐（hibernate / LRU）

后台插件不是无限保活的：

| 机制 | 参数 | 行为 |
|------|------|------|
| 空闲休眠 | `PLUGIN_HIBERNATE_DELAY_MS = 3 分钟` | background 后无激活 → 快照 `storage.session` → 销毁 View，逻辑 Tab 保留 |
| LRU 上限 | `PLUGIN_ALIVE_LIMIT = 6` | 存活插件超限时，最久未激活的 background 插件立即休眠 |
| dev 白名单 | `summary.dev === true` | 开发者控制台加载的插件 **永不休眠 / 不参与 LRU 驱逐**（保 HMR 稳定） |
| Quick 容器 | 同样适用 | Esc 回列表 / 小窗失焦隐藏即退 background 并计时；驱逐后再次呼出走冷启动 + 快照恢复 |

**对插件的影响**：

1. 你的页面可能被销毁重建——**初始化逻辑必须可重入**，`onEnter` 每次重建后都会再次触发；
2. `storage.session` 在休眠时自动快照、唤醒时自动恢复（覆盖式），但**重要状态仍必须写 `storage.*`（local）**——快照在卸载 / crash 后不保证存在；
3. 休眠期间的 `onBeforeClose` / `onDestroy` 是尽力而为（进程可能已不在），持久化不要依赖它们兜底。

---

## crash 自动重启

渲染进程崩溃（`render-process-gone`）时：

- **首次 crash**：壳子自动重启（reopen 一次），按崩溃前所在容器（主窗 Tab / Quick）回到原位，session 快照恢复同休眠唤醒；
- **连续第二次 crash**：保留逻辑 Tab 但不再自动重启，渲染层经 `plugin-error` 显示崩溃态，等用户手动重开；
- 加载完成后稳定存活 10s（`CRASH_RECOVERY_STABLE_MS`）视为已恢复，重置自动重启额度。

---

## 插件侧 API

```js
const api = window.enest // zapi 为 @deprecated 别名，计划 v2 移除

// 进入：首次加载完成 + 每次 Tab 激活 + 休眠唤醒 / crash 重启重建
const offEnter = api.onEnter(({ tabId, code, payload }) => {
  // code 对应 features[].code；payload 为透传数据
  resumeUi()
})

// 切到后台（不销毁；但注意空闲后可能被休眠）
api.onOut(() => {
  pauseHeavyWork()
})

// 即将销毁：可返回 Promise，preload 等 settle 再 ack（主进程超时 1500ms）
api.onBeforeClose(async ({ reason }) => {
  // reason: 'tab-close' | 'uninstall' | 'app-quit'
  await api.storage.session.set('closed-by', reason)
})

// 关闭已开始（尽力而为；清理请放 onBeforeClose）
api.onDestroy(() => {
  console.log('destroyed')
})

// 同步身份工具（不走 IPC）
console.log(api.getPluginId())
console.log(api.getEnterCode())
```

所有 `onXxx` 返回 **取消订阅函数**：

```js
const off = api.onEnter(handler)
// 不再需要时
off()
```

---

## Handler 侧实现参考

### PluginHost：打开与激活（概念节选）

```ts
// openPlugin — 幂等：已存在则激活；hibernated 则快照恢复重建
async openPlugin(pluginId: string, enter?: PluginEnterPayload, container?: 'shell' | 'quick') {
  const existing = this.views.get(pluginId)
  if (existing) {
    this.activatePlugin(pluginId)
    this.sendLifecycle(pluginId, {
      event: 'enter',
      tabId: toTabId(pluginId),
      code: enter?.code,
      payload: enter?.payload
    })
    return
  }
  // 唤醒休眠插件：loadSessionSnapshot 回填 sessionBag
  if (this.hibernated.has(pluginId)) {
    const snapshot = loadSessionSnapshot(pluginId)
    if (snapshot) for (const [k, v] of Object.entries(snapshot)) sessionBag(pluginId).set(k, v)
    this.hibernated.delete(pluginId)
  }
  // 1. partition 隔离
  const ses = session.fromPartition(`persist:plugin-${pluginId}`)
  // 2. 注册 enest://plugin/{id} 协议
  // 3. new WebContentsView({ webPreferences: { preload: pluginPreloadPath, ... } })
  // 4. loadURL(development.main ?? enest://plugin/{id}/{main}?pid=..&code=..)
  // 5. did-finish-load 后 setBounds + setVisible(true) + 广播 enter
  // 6. quick 容器：hookQuickInput（Esc 回列表 / ⌘Enter 固定主窗）+ 高度自适应
}

// activatePlugin — 仅显隐，不销毁
activatePlugin(pluginId: string) {
  const view = this.views.get(pluginId)
  if (!view) return
  for (const [id, v] of this.views) {
    const active = id === pluginId
    v.setVisible(active)
    if (!active) {
      this.sendLifecycle(id, { event: 'out', isKill: false })
    }
  }
  this.sendLifecycle(pluginId, {
    event: 'enter',
    tabId: toTabId(pluginId)
  })
}

// closePlugin — 立即销毁
async closePlugin(pluginId: string, reason: PluginCloseReason = 'tab-close') {
  const view = this.views.get(pluginId)
  if (!view) return
  this.sendLifecycle(pluginId, { event: 'beforeClose', reason })
  // 等待 ack，最多 1500ms（preload 等 Promise settle 后 ack）
  await this.waitForBeforeCloseAck(pluginId, 1500)
  this.sendLifecycle(pluginId, { event: 'destroy' })
  view.webContents.close()
  clearPluginSession(pluginId) // PluginSessionStore
  this.views.delete(pluginId)
}
```

### preload：派发与 Promise-aware ack（节选）

```ts
ipcRenderer.on(IpcChannels.PluginLifecycle, (_e, message) => {
  switch (message.event) {
    case 'enter':
      emit('enter', { tabId: message.tabId, code: message.code, payload: message.payload })
      break
    case 'out':
      emit('out', { isKill: false })
      break
    case 'beforeClose': {
      // 收集监听器返回的 thenable；任一返回 Promise 即等全部 settle 再 ack
      const pending = emitAndCollectPromises('beforeClose', { reason: message.reason })
      if (pending.length > 0) {
        const cap = setTimeout(ackOnce, 2000) // 本地防悬挂 cap
        Promise.all(pending).then(() => { clearTimeout(cap); ackOnce() })
      } else {
        setTimeout(ackOnce, 50) // 同步 flush 余量
      }
      break
    }
    case 'destroy':
      emit('destroy', undefined)
      break
  }
})
```

### 插件页：推荐 pause / resume 骨架

```js
const api = window.enest // zapi 为 @deprecated 别名
let timer = null

function resume() {
  if (timer) return
  timer = setInterval(tick, 1000)
}

function pause() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

api?.onEnter(() => resume())
api?.onOut(() => pause())
api?.onBeforeClose(() => {
  pause()
  // 同步或 fire-and-forget 持久化；需要等待时返回 Promise（≤1500ms）
})
```

---

## 打开（Open）

触发：市场卡片、已安装列表、开发者加载本地目录、Quick 命令（`form: 'mini'` 插件）。

主进程 `PluginHost` 步骤（container：`shell` 主窗 Tab / `quick` 小窗内嵌）：

1. 解析安装路径；未安装则从示例 / 目录安装
2. 唤醒检查：若该插件 hibernated，先 `loadSessionSnapshot` 回填 `storage.session`（自动覆盖）
3. `session.fromPartition('persist:plugin-' + id)` 创建隔离会话
4. 为该 session 注册 `enest://plugin/{id}` 协议映射
5. `new WebContentsView`，注入统一 `pluginPreload`（暴露 `window.enest`；`zapi` 为 deprecated 别名）
6. 加载 URL：优先 `development.main`（开发态），否则 `enest://plugin/{id}/{main}`
   - query 携带 `pid` 与可选 `code`，便于 preload 同步解析
7. `setBounds`：shell 容器铺到内容区（标题栏 + 插件条之下）；quick 容器从输入条之下铺满（见 [UI 标准 → mini 插件](ui-standard.md)）
8. 推送 `shell:event` → `plugins-changed`，壳子出现 Tab
9. `did-finish-load` 后注入主题 Token（`themeAware`）并广播 `enter`

加载失败推送 `plugin-error`（见 [错误码](errors.md)）。

---

## 切换（Activate）

- 多 Tab 并行：每个插件独立 View / 进程 / partition
- 激活仅改 `setVisible(true/false)`，**不销毁**不可见 Tab（但后台空闲可能休眠，见上）
- 窗口 resize 时 `layoutAll()` 重算所有插件 bounds
- 切走插件收到 `onOut({ isKill: false })`；切回再次收到 `onEnter`
- shell 与 quick 两个容器各自的激活互不干扰（可同时各有一个激活插件）

---

## 重载（Reload）

开发者控制台「热重载」或 IPC `shell:reload-plugin`：

```text
webContents.reload()  →  重新加载 development.main 或 enest:// 入口
```

- 修改 `plugin.json` **权限** 后建议关 Tab 重开，确保清单重新读取
- Vite HMR 本身不需要壳子 reload；只在 preload / 权限变更时需要

---

## 关闭 / 卸载

| 动作 | reason | 行为 |
|------|--------|------|
| 关闭 Tab | `tab-close` | `beforeClose` → `destroy` → `webContents.close()` → 清 session KV |
| 关闭窗口 / 退出 | `app-quit` | `destroyAll()` 销毁全部插件 View |
| 卸载插件 | `uninstall` | 另应清理 partition 数据 + 删除 `plugin-storage/{id}.json` |

**设计取舍**：关闭即销毁，内存可预期。日常关闭 **不清除** partition localStorage / `storage.local`（用户数据保留）；**卸载时**才清理两者。

---

## 与页面原生事件配合

壳子生命周期与 DOM 事件互补：

```js
// 页面被隐藏/卸载前（浏览器原生）
window.addEventListener('pagehide', () => {
  // 同步或 sendBeacon；勿依赖 unload 异步完成
})

// Tab 切换可见性
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause()
  else resume()
})
```

!> 壳子不保证插件进程常驻（关 Tab 即回收；后台空闲也会休眠）。**重要状态请写 `enest.storage`（local），不要只放内存或 session。** `storage.session` 在关 Tab 时清空（休眠路径有快照恢复，但 crash / 卸载后不保证）。

---

## 与 uTools 对照

| 阶段 | uTools | eNest |
|------|--------|-------|
| 进入 | `onPluginEnter` | `onEnter` |
| 切走 | `onPluginOut(false)` | `onOut({ isKill: false })` |
| 杀死 | `onPluginOut(true)` | `onBeforeClose` + `onDestroy` |
| 分离窗口 | `onPluginDetach` | `pinToShell`（Quick 内嵌 → 主窗 Tab，⌘Enter 触发） |
| 单例 | `pluginSetting.single` 默认 true | 默认单例，无多实例 |
| 多面板 | 单面板 + 隐藏 | **多 Tab 并存**（eNest 特色） |
| 后台回收 | 隐藏保活 | **空闲休眠 + LRU**（session 快照恢复） |

---

## 相关文档

- [enest API](api.md) — onEnter / onOut 等完整签名
- [调试与热更新](debug.md)
- [错误码](errors.md)
