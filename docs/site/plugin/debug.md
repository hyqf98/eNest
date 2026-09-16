# 调试与热更新

开发者控制台对齐 uTools 开发台：本地目录、HMR、DevTools、日志。

## 开发者控制台

1. 壳子左下角点击「开发者」
2. **加载本地目录**：选择包含 `plugin.json` 的文件夹
3. **热重载**：重新加载当前插件 View
4. **DevTools**：打开 Chromium 调试器

对应 IPC：`shell:load-dev-plugin` / `shell:reload-plugin` / `shell:open-devtools`。

## Vite 热更新

```bash
# 终端 1：前端
npm run dev   # 例如 http://127.0.0.1:5173
```

```json
{
  "development": {
    "main": "http://127.0.0.1:5173/index.html"
  }
}
```

在开发者控制台加载该插件目录后，壳子优先使用 `development.main`。

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

> 示例插件：`plugins-samples/hello`，含 README、storage 与 notify 调用，见 [示例插件](examples.md)。
