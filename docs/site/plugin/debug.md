# 调试与热更新

开发者控制台对齐 uTools 开发台：本地目录、HMR、DevTools、日志。

## 开发者控制台

1. 壳子左下角 →「设置 → 开发者」（或开发者页）
2. **选择目录**：系统文件夹选择器，选中含 `plugin.json` 的目录  
   也可直接输入绝对路径后点「加载本地目录」
3. 加载成功后 **自动在壳内打开插件 Tab**，可立即调试
4. **热重载**：重新加载当前插件 View（文件插件会重新绑定 `enest://` 根路径）
5. **DevTools**：打开当前插件的 Chromium 调试器
6. 「开发中」列表点击条目可再次打开；带 `HMR` 标签表示配置了 `development.main`

对应 IPC：`shell:load-dev-plugin` / `shell:reload-plugin` / `shell:open-devtools`。

## Vite 热更新

```bash
# 终端 1：插件前端
cd /path/to/my-plugin
npm run dev   # 例如 http://127.0.0.1:5173
```

```json
{
  "development": {
    "main": "http://127.0.0.1:5173/index.html"
  }
}
```

在开发者控制台选择该插件目录后，壳子优先加载 `development.main`，Vite HMR 即时生效。

## 静态文件调试

无 `development.main` 时，从插件目录原地读取 `index.html`（不复制到 `~/eNest/plugins`）。改文件后点「热重载」即可。

> 开发者控制台加载的 dev 插件 **永不休眠、不参与 LRU 驱逐**（保 HMR 稳定）；正式安装的插件后台空闲 3 分钟会被休眠（session 快照恢复，见 [生命周期](lifecycle.md)），调试长驻行为时注意区分。

## CDP 自动化（可选）

```bash
ENEST_REMOTE_DEBUG=9222 npm run dev
# Playwright MCP --cdp-endpoint http://127.0.0.1:9222
```

## 常见问题

| 现象 | 处理 |
|------|------|
| API 调用报权限错误 | 检查 `plugin.json` permissions，见 [错误码](errors.md) |
| 白屏 | DevTools 看 Console；确认 main 路径 |
| HMR 不生效 | 确认 `development.main` 端口；关 Tab 再开 |
| 本地图片 404 | 生产请用插件内相对路径或 enest 协议资源 |
| 选目录后 Tab 没出现 | 看开发者日志；确认 `plugin.json` 必填字段 |
| 重新加载路径没变 | 热重载会重绑协议；若仍旧，关 Tab 后重新加载目录 |
