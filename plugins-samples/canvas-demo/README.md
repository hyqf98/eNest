# Canvas 动效演示

演示 eNest 统一插件 UI 标准的示例插件：

| 配置 | 值 | 效果 |
|------|-----|------|
| `ui.chrome` | `none` | 无插件工具条，内容全幅（标题栏以下） |
| `ui.themeAware` | `true` | 壳子注入 CSS 变量，主题切换时推送 `theme-change` |
| `ui.background` | `transparent` | WebContents 透明底，Canvas 透出壳子背景 |
| `ui.preferredColorScheme` | `auto` | 跟随壳子 light/dark（含系统主题） |

## 要点

- Canvas 使用 `clearRect` 清屏，不在页面绘制不透明底色
- 颜色从 `enest.theme.getTokens()` / `ui.onThemeChange` 读取，与壳子 Token 对齐
- 也可在 `<head>` 静态引入 `enest://plugin/{id}/__enest_theme.css`

## 安装

从市场安装「Canvas 动效演示」，或：

```bash
# 拖入 eNest 窗口，或复制到 ~/eNest/plugins/com.enest.canvas-demo/1.0.0/
cp -R plugins-samples/canvas-demo ~/Desktop/canvas-demo
```
