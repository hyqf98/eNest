# eNest 自动化与 MCP 接入

## 1. 项目内 Electron 自动化（已可用）

依赖：`playwright-core`（驱动本机 Electron，无需下载浏览器内核）。

```bash
npm run build
npm run e2e:smoke
```

脚本：`scripts/e2e-smoke.mjs`

- `_electron.launch` 拉起 eNest
- 校验市场首页、打开插件、进入设置
- 截图输出到 `e2e-artifacts/`

可在此基础上扩展：多 Tab、安装/卸载、主题切换、开发者控制台。

### CDP 远程调试（给外部 MCP / 工具连）

启动时加：

```bash
npx electron . --remote-debugging-port=9222
# 或
ENEST_REMOTE_DEBUG=9222 npm run dev
```

主进程已识别 `ENEST_REMOTE_DEBUG`。之后 CDP 地址为：

```
http://127.0.0.1:9222
```

---

## 2. 给 MiMo Desktop 装 MCP（自动化外部操作）

MiMo **不能**在本会话里热加载新 MCP。请在桌面端：

**设置 → MCP → 添加服务器**，然后 **新开一个对话** 才会生效。

### 方案 A：Playwright MCP（推荐，浏览器/CDP）

```json
{
  "playwright": {
    "type": "local",
    "command": ["npx", "@playwright/mcp@latest"],
    "enabled": true
  }
}
```

连已在跑的 eNest（先 `ENEST_REMOTE_DEBUG=9222 npm run dev`）：

```json
{
  "playwright": {
    "type": "local",
    "command": [
      "npx",
      "@playwright/mcp@latest",
      "--cdp-endpoint",
      "http://127.0.0.1:9222"
    ],
    "enabled": true
  }
}
```

能力：快照、点击、输入、截图、导航。适合 eNest 壳子 UI 与普通网页。

### 方案 B：Computer Use 插件（任意桌面窗口）

适合操作 **没有 CDP 的原生窗口**（系统对话框、其它 App）。

- 安装并启用 **Computer Use** 插件（设置 → 插件 / Computer）
- 授予辅助功能、屏幕录制权限
- 工具：截图 + 鼠标键盘

比 Playwright 粗，但覆盖面广。

### 方案 C：Browser Use 插件

只控 **应用内浏览器**，不适合完整 Electron 桌面壳；网页调试可用。

---

## 3. 选型建议

| 目标 | 方案 |
|------|------|
| 测/控 eNest 自己 | 项目内 `playwright-core` + `e2e:smoke` |
| 在 MiMo 会话里点 eNest UI | Playwright MCP + `--cdp-endpoint` |
| 控其它 Electron / 原生窗口 | Computer Use |
| 纯网页 | Playwright MCP 默认启动浏览器 |

---

## 4. 安全注意

- CDP 端口仅本机监听，不要暴露到公网。
- MCP 配置变更 **仅对新对话** 生效。
- 自动化会真实点击 UI，测试插件时注意权限弹窗。
