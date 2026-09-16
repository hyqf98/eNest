# 示例插件

仓库 `plugins-samples/` 提供可直接在开发者控制台加载的示例。

## 目录一览

| 示例 | 演示点 |
|------|--------|
| `hello` | 最小插件：标题、通知、README |
| `todo` | 本地待办 + `storage.local` |
| `clipboard` | 剪贴板读写 |
| `color` | 取色 / UI 交互 |
| `json` | 工具型单页 |
| `snippet` | 片段管理 |
| `translate` | 翻译类示例 |
| `canvas-demo` | 统一 UI 标准：`chrome=none`、主题感知、透明底 Canvas 动画 |

以实际仓库目录为准；市场 Mock 数据在主进程 `mockMarket.ts`。

## 加载示例

```bash
# 仓库根
npm install
npm run dev
```

1. 壳子左下角 →「开发者」
2. 「加载本地目录」→ 选择 `plugins-samples/hello`
3. 打开 Tab，对照源码阅读 API 调用

## hello 要点

```json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "main": "index.html",
  "permissions": ["ui.setTitle", "storage.local", "notify"]
}
```

- 使用 `window.enest || window.zapi`
- 声明最小权限集
- 根目录 `README.md` 供市场详情渲染

## 从示例起步

```bash
cp -R plugins-samples/hello my-hello
# 改 plugin.json 的 id / name，避免与内置示例冲突
```

下一步：[生命周期](lifecycle.md) · [FAQ](faq.md)
