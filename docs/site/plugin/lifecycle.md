# 生命周期

插件在壳子中以 **WebContentsView** 存在：打开 → 可见/切换 → 重载 → 关闭销毁。**无 LRU 保活**，关 Tab 即回收。

## 状态流转

```text
未安装 ──安装──► 已安装 ──打开──► 运行中（Tab）
                              │
                    激活/隐藏 ◄┘
                              │
                            重载（reload）
                              │
                          关闭 Tab ──► 销毁 View / 进程
```

## 打开（Open）

触发：市场卡片点击、已安装列表打开、开发者加载本地目录。

主进程 `PluginHost` 大致步骤：

1. 解析安装路径；未安装则从示例/目录安装
2. `session.fromPartition('persist:plugin-' + id)` 创建隔离会话
3. 为该 session 注册 `enest://plugin/{id}` 协议映射
4. `new WebContentsView`，注入 `pluginPreload`（暴露 `window.enest` / `zapi`）
5. 加载 URL：优先 `development.main`（开发态），否则 `enest://plugin/{id}/{main}`
6. `setBounds` 铺到内容区（标题栏 + 插件条之下）
7. 推送 `shell:event` → `plugins-changed`，壳子出现 Tab

加载失败会推送 `plugin-error` 事件（见 [错误码](errors.md)）。

## 切换（Activate）

- 多个 Tab 并行：每个插件独立 View / 进程 / partition
- 激活仅改 `setVisible(true/false)`，**不销毁**不可见 Tab
- 窗口 resize 时 `layoutAll()` 重算所有插件 bounds

## 重载（Reload）

开发者控制台「热重载」或 IPC `shell:reload-plugin`：

```text
webContents.reload()  →  重新加载 development.main 或 enest:// 入口
```

- 修改 `plugin.json` 权限后建议关 Tab 重开，确保清单重新读取
- Vite HMR 本身不需要壳子 reload；只在 preload/权限变更时需要

## 关闭 / 卸载（Close）

| 动作 | 行为 |
|------|------|
| 关闭 Tab | `webContents.close()` → 移除 View → 事件 `tab-closed` |
| 关闭窗口 | `destroyAll()` 销毁全部插件 View |
| 卸载插件 | 移除 `~/eNest/plugins/{id}/{version}/`；partition 数据是否清理视版本策略 |

**设计取舍**：关闭即销毁，保证内存可预期；插件需要在 `pagehide` / `beforeunload` 里自行 flush 关键状态（优先写 `storage`）。

## 插件侧建议钩子

```js
// 页面被关闭/隐藏前保存
window.addEventListener('pagehide', () => {
  // 同步或 fire-and-forget 写入；勿依赖 unload 异步完成
  navigator.sendBeacon?.('/noop') // 视需要
})

// 可见性变化（Tab 切换）
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseHeavyWork()
  else resumeHeavyWork()
})
```

?> 壳子不保证插件进程常驻；**重要状态请写 `enest.storage`，不要只放内存。**

## 相关文档

- [调试与热更新](debug.md)
- [错误码](errors.md)
