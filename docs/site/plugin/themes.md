# 主题与综合插件

主题插件使用同一个源码、开发加载和发布格式：`main: "index.html"`、包内图标、README 和真实截图都必需。入口页用于预览主题、说明配色与提供可达的注册操作，不能省略页面改成只有 JSON 的特殊包。

## 声明式主题

在 `plugin.json.contributes.themePacks` 声明主题（下列是 manifest 片段）：

```json
{
  "contributes": {
    "themePacks": [{
      "id": "com.example.theme.ocean",
      "name": "海蓝",
      "mode": "dark",
      "tokens": { "--bg": "#151d29", "--text": "#e7edf6", "--accent": "#78a9ed" }
    }]
  }
}
```

宿主扫描启用插件时注册，不要求打开页面，不额外要求 `theme` 权限。source 由宿主绑定插件 ID，不能覆盖其它插件的同名主题。token 使用白名单并过滤非法值；按 [UI 标准](ui-standard.md) 选择已有变量。

## 运行时注册

需要生成配色的主题编辑器直接使用基础能力，在用户点击操作后调用，无需声明 `theme` 或取得单项授权：

```js
await enest.theme.register({
  id: 'com.example.theme.custom', name: '自定义海蓝',
  source: enest.getPluginId(), mode: 'dark',
  tokens: { '--bg': '#151d29', '--text': '#e7edf6', '--accent': '#78a9ed' }
})
```

source 在宿主仍会重写，`enest.builtin` 是保留的宿主来源。背景只接受安全纯色或本插件 `enest://plugin/<id>/assets/...` 的图片/视频，不能借主题加载外部地址或其它插件资源；每插件最多 8 个主题包，允许覆盖自己的同 ID 主题。注册后宿主发出 `theme-packs-changed`，主题列表刷新。注册不是自动应用，用户到壳设置 → 外观选择主题。没有插件任意删除其它主题的 API。

关闭页面不撤销已注册主题；禁用或卸载插件会按 source 撤销它的主题与贡献点，当前选中的包若被删除会回到普通主题。重新启用恢复声明式主题；运行时生成的主题按插件自己的保存与注册流程恢复。

预览页应展示文本、输入、列表、按钮和语义状态，并支持浅深色、Quick 窄窗与主窗。只在插件预览区域应用草稿变量，不假定能直接操作壳 renderer DOM。真实示例位于 `plugins/com.enest.theme-demo/`。

## 综合贡献点

工具页面、Quick 指令、设置、首页卡片、轨道入口与主题可组合在同一个插件 ID 下：

- `features` 为入口提供 code；页面通过 `onEnter` 接收对应 code 与 payload。
- `contributes.settings/homeCards/railEntries/themePacks` 是声明式贡献，由宿主统一装载和卸载。
- 运行时 Quick provider 用 `enest.contribute`，因接收全局搜索文本需声明和授权 `contribute`；及时响应查询并清理订阅。普通声明式入口无需该权限。
- 涉及系统或外部资源时分别申请最小敏感权限；“综合插件”不提供绕过其它权限的总开关。
- Quick / 主窗由 `getLaunchMode` 和 `onModeChange` 决定内容模式；宽度断点只处理实际空间。

验收时检查安装、启用、禁用、卸载后的贡献点与主题列表，不应留下无来源的条目。样式布局与 [生命周期](lifecycle.md) 约定同样适用。
