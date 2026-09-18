# eNest 插件标准结构（对齐 uTools）

参考 uTools 插件约定，eNest 插件推荐如下目录形态。**打包与本地加载使用同一结构**，`plugin.json` 必须位于包根。

## 标准目录

```
{pluginId}/                    # 目录名 === plugin.json.id
├── plugin.json                # 必选清单（权威元数据）
├── logo.png                   # 可选 128×128 或 512×512，市场图标
├── index.html                 # 入口页面（ui.chrome 缺省 none，全幅渲染）
├── settings.html              # 可选设置页（预留）
├── assets/                    # 静态资源（打包时一并进入 .enestplugin）
│   ├── css/
│   │   └── main.css
│   ├── js/
│   │   └── main.js
│   └── images/
│       └── ...
└── README.md                  # 可选，市场详情展示
```

## 与 uTools 的对应

| uTools | eNest |
|--------|-------|
| `plugin.json` | `plugin.json`（字段子集对齐，权限键见壳子权限表） |
| `logo.png` | `logo.png` / `icon.png` / `icon.svg` |
| `index.html` | `main` 默认 `index.html` |
| 静态资源任意路径 | 建议统一放 `assets/`，相对路径引用 |
| `utools.*` API | `window.enest`（`zapi` 为 deprecated 别名） |
| 开发加载目录 | 设置 → 开发者 →「加载插件」 |
| HMR | `development.main` 指向 Vite 等 |

## plugin.json 最小示例

```json
{
  "id": "com.example.myplugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "一句话说明",
  "author": "you",
  "main": "index.html",
  "category": "效率",
  "icon": "logo.png",
  "permissions": ["storage.local", "ui.setTitle", "ui.toast"],
  "engines": { "enest": ">=0.1.0" },
  "features": [
    { "code": "main", "explain": "主功能", "cmds": ["我的插件", "myplugin"] }
  ],
  "ui": {
    "chrome": "none",
    "themeAware": true,
    "background": "opaque",
    "preferredColorScheme": "auto"
  },
  "development": {
    "main": "http://127.0.0.1:5173/index.html"
  }
}
```

> `ui.chrome` 缺省为 `none`：壳子不绘制名称/URL 顶栏，插件全幅渲染。仅历史插件可显式 `"chrome": "minimal"` 保留细条。

## 打包

```bash
# monorepo 内
node eNest_plugin/scripts/pack-plugin.mjs com.example.myplugin
# 产出 {id}@{version}.enestplugin（zip，plugin.json 在根）
```

## 本地调试

1. `npm run dev` 启动壳子  
2. 设置 → 开发者 → **加载插件**（选中 `{pluginId}/` 目录）  
3. 列表中点 **启动调试**（停留在开发者页）→ 需要时点 **查看** / DevTools / 热重载  
4. **停止调试** 关闭 View；**移除** 只从开发列表去掉（不删源码）
