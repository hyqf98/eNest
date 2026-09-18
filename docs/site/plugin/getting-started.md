# 快速开始

环境要求、最小插件、在壳子中加载与调试。

## 环境

- Node.js ≥ 20
- eNest 壳子源码可运行（`npm run dev`）
- 任意编辑器（推荐 VS Code）

## 1. 最小插件

创建目录 `my-hello/`：

```text
my-hello/
├── plugin.json
└── index.html
```

### plugin.json

```json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "main": "index.html",
  "permissions": ["ui.setTitle", "storage.local", "notify"]
}
```

### index.html

```html
<!DOCTYPE html>
<html>
<body>
  <h1>Hello eNest</h1>
  <button id="go">打招呼</button>
  <script>
    // zapi 为 deprecated 别名；本地双名兜底写法，壳子环境 enest 必有
    const api = window.enest ?? window.zapi
    document.getElementById('go').onclick = async () => {
      await api.ui.setTitle('Hello')
      await api.notify({ title: 'Hello', body: '来自插件' })
    }
  </script>
</body>
</html>
```

## 2. 在壳子中加载

1. 启动壳子：`npm run dev`
2. 左下角打开「开发者」
3. 「加载本地目录」选择 `my-hello/`
4. 点击打开，顶部出现 Tab

## 3. 使用前端框架（可选）

与 uTools 类似：用 Vite / React / Vue 构建，把 `main` 指向产物 `dist/index.html`，或开发时写：

```json
{
  "development": {
    "main": "http://127.0.0.1:5173/index.html"
  }
}
```

> ⚠️ 打包发布时请提交**编译后的静态文件**，不要提交整个 node_modules 工程根目录。

## 4. README 与市场详情

插件根目录提供 `README.md` 后，市场卡片点击进入详情会渲染该文档
（壳子调用 `shell:get-plugin-readme`）。

## 下一步

[plugin.json 字段 →](manifest.md)
