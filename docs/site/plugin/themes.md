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

## 启动与工作台背景动效

主题包可通过 `backgroundEffects` 提供背景动效，沿用 `contributes.themePacks` 或 `enest.theme.register`。注册后，用户在壳设置中选择动效；该选择保存在 `theme.backgroundEffect`，供启动画面和工作台使用。注册不会自动替用户切换背景，也不需要新增权限。

宿主内置 `fold`（空间折叠）、`aurora`（极光绸缎）、`orbit`（引力光环）、`ripple`（液态波纹）、`tunnel`（光域隧道）。默认值为 `tunnel`，`none` 表示关闭。插件有两种扩展方式：

| renderer | 必填字段 | 可选字段 | 用途 |
| --- | --- | --- | --- |
| `preset` | `id`、`name`、`preset` | `description`、`colors`、`speed`、`logoStyle` | 使用宿主效果，调整三色配色和速度 |
| `video` | `id`、`name`、`video` | `description`、`poster`、`logoStyle` | 播放插件自带的原创循环动画 |

每个主题包最多 8 个动效，`id` 在包内唯一，必须以英文字母开头，仅含字母、数字、下划线和连字符，最长 48 字符。`name` 最长 64 字符，`description` 最长 200 字符；文字不能包含控制字符或首尾空白。`colors` 必须恰好包含三个 `#RRGGBB` 颜色，`speed` 为 0.25–2 的有限数字。`logoStyle` 从上述五个内置值中选择，只控制启动 Logo 的呈现编排，不允许传入脚本。

`video` 只接受本插件 `enest://plugin/<插件 ID>/assets/...` 下的 `.mp4` / `.webm`；`poster` 接受同一来源下的 `.png` / `.jpg` / `.jpeg` / `.webp` / `.avif` / `.gif`。建议提供静态封面，并将视频制作成可无缝循环的画面，中央留出 Logo、标题和说明的阅读区域。视频按宿主策略静音循环，并随窗口可见性和背景是否被覆盖暂停。

下面片段可合并到 ID 为 `com.example.backgrounds` 的普通插件 manifest；仍需保留本页开头要求的入口页、图标、README 和真实截图。将视频与封面实际放在 `assets/backgrounds/`。第一项不需要额外媒体文件：

```json
{
  "id": "com.example.backgrounds",
  "contributes": {
    "themePacks": [{
      "id": "com.example.backgrounds.night",
      "name": "夜色背景",
      "mode": "dark",
      "tokens": {},
      "backgroundEffects": [
        {
          "id": "jade-silk",
          "name": "翡翠绸缎",
          "description": "青绿丝带与淡金折光",
          "renderer": "preset",
          "preset": "aurora",
          "colors": ["#071B20", "#3AD7AE", "#F5DCA1"],
          "speed": 0.75,
          "logoStyle": "aurora"
        },
        {
          "id": "fold-film",
          "name": "原创折叠动画",
          "renderer": "video",
          "video": "enest://plugin/com.example.backgrounds/assets/backgrounds/fold.webm",
          "poster": "enest://plugin/com.example.backgrounds/assets/backgrounds/fold.webp",
          "logoStyle": "fold"
        }
      ]
    }]
  }
}
```

只想先试预设参数，可以将下面代码作为插件 `index.html` 的内容运行，无需视频资源。点击按钮会注册一个背景主题包，然后到壳设置中选择“翡翠绸缎”：

```html
<!doctype html>
<html lang="zh-CN">
<meta charset="UTF-8">
<title>背景动效预览</title>
<button id="register-backgrounds" type="button">注册翡翠绸缎</button>
<p id="status" role="status"></p>
<script type="module">
  const button = document.querySelector('#register-backgrounds')
  const status = document.querySelector('#status')
  button.addEventListener('click', async () => {
    button.disabled = true
    try {
      const source = enest.getPluginId()
      await enest.theme.register({
        id: `${source}.backgrounds`,
        name: '翡翠背景', source, mode: 'dark', tokens: {},
        backgroundEffects: [{
          id: 'jade-silk', name: '翡翠绸缎',
          renderer: 'preset', preset: 'aurora',
          colors: ['#071B20', '#3AD7AE', '#F5DCA1'],
          speed: 0.75, logoStyle: 'aurora'
        }]
      })
      status.textContent = '已注册，请到壳设置选择翡翠绸缎。'
    } catch (error) {
      status.textContent = String(error)
    } finally {
      button.disabled = false
    }
  })
</script>
</html>
```

宿主将插件选项映射为 `plugin:<编码后的 source>:<编码后的 packId>:<编码后的 effectId>`。开发者只填写包内短 ID，宿主负责生成选择值；即使插件把短 ID 写成 `tunnel`，也不会替换内置效果。选择的背景所属插件被禁用、卸载，或注册更新删除了该选项后，界面回退到默认光域隧道。主题包加载时会再次校验；动效随主题包按 source 一起回收。

字段采用白名单。自定义 JavaScript、HTML、shader、外链、任意本地路径、跨插件资源、路径穿越和超额声明均不接受；注册非法动效时整次更新失败，原来的主题包保持不变。需要完全不同的动画时，使用自己制作的本地视频，不向宿主注入渲染代码。

### 全局氛围色与运行策略

背景动效选择同时应用到启动画面、主窗口、Quick 和独立插件窗口。设置中的氛围色独立于动效选择，以柔光叠色保留程序或视频动效的细节；修改纯色、渐变或强度即时更新，不重建当前 GPU 场景。关闭动效后，氛围色仍在这些界面显示。图片和普通背景视频保留原配置，在动效关闭时显示。原生插件页面是否能透出宿主背景仍取决于该插件的透明背景声明。

程序动效遵守用户动画档位：低档以 12 FPS、指定速度的 0.35 倍缓慢运行，绘制预算不超过 36 万像素；中/高档分别以最高 30/60 FPS 运行。低档视频显示海报而不持续解码，系统减少动态效果时所有背景保持静态。隐藏或失焦暂停，切换和卸载释放对应渲染资源。插件无需自行实现这些调度规则。

## 综合贡献点

工具页面、Quick 指令、设置、首页卡片、轨道入口与主题可组合在同一个插件 ID 下：

- `features` 为入口提供 code；页面通过 `onEnter` 接收对应 code 与 payload。
- `contributes.settings/homeCards/railEntries/themePacks` 是声明式贡献，由宿主统一装载和卸载。
- 运行时 Quick provider 用 `enest.contribute`，因接收全局搜索文本需声明和授权 `contribute`；及时响应查询并清理订阅。普通声明式入口无需该权限。
- 涉及系统或外部资源时分别申请最小敏感权限；“综合插件”不提供绕过其它权限的总开关。
- Quick / 主窗由 `getLaunchMode` 和 `onModeChange` 决定内容模式；宽度断点只处理实际空间。

验收时检查安装、启用、禁用、卸载后的贡献点与主题列表，不应留下无来源的条目。样式布局与 [生命周期](lifecycle.md) 约定同样适用。
