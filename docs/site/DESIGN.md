# eNest 官网视觉规格 — 暗色剧场 + 差值碰撞

## 诊断（改前）

旧版是典型 AI/SaaS 模板：纸白底 + 青绿强调、居中 section-head、交错 feature-row、圆角浅卡。
「瀑布」只是 masonry 淡入，不是整屏级视觉。缺少主视觉记忆点。

## 风格锚点

- 产品气质：eNest 深色模式 + orb 圆轨 + 薄荷绿状态色
- 参考类：桌面工具官网的暗色「剧场」段落（Linear / Raycast 级别的对比与节奏），但自己定 palette，不抄布局
- 一句话：**近黑连续舞台上的产品展示，大标题用 difference 与背景色光碰撞**

## Color

| Token | Hex | 用途 |
|-------|-----|------|
| `--ink` | `#050708` | 全页底 |
| `--panel` | `#0c1214` | 卡片 / 壳子外框 |
| `--panel-2` | `#121a1c` | 次级面 |
| `--text` | `#e8f5f0` | 主文字 |
| `--muted` | `#8a9a94` | 次文字 |
| `--faint` | `#5a6a64` | 辅助 / mono 标签 |
| `--line` | `rgba(232,245,240,0.08)` | 分隔线 |
| `--mint` | `#14b892` | 主强调 / 按钮 |
| `--mint-hot` | `#5eead4` | 差值层 / hover 高光 |
| `--amber` | `#f5a524` | 仅点缀（次强调） |
| `--danger` | `#ff6b7a` | 错误态 |

壳子仿真 token 保持与 `src/renderer` 深色模式对齐（`#0d1118` / `#161b24` / `#3dd68c`）。

## Typography

- Display：`Inter, "PingFang SC", system-ui` — 700–800，`clamp(40px, 7vw, 88px)`，`letter-spacing: -0.05em`
- Body：同族 400–500，15–16px / 1.7
- Mono：`JetBrains Mono, "SF Mono", Menlo` — 版本号、快捷键、步骤编号、安装量
- 中文显示字用 Inter 回退 PingFang；布局按 fallback 字宽校验

## Layout

- 全页 `--ink` 连续，不再有纸白块
- `--max: 1160px`，左右 `20–28px`
- 节奏：`hero → 信任跑马灯 → sticky 剧场舞台 → 插件瀑布帘幕 → 隔离网格 → 步骤 → CTA → footer`
- 密度偏紧：卡片 `14–18px` 内边距，section 间距 `64–96px`

## Signature

1. **差值碰撞大标题**：白字 `mix-blend-mode: difference`，背后铺 mint/amber 径向光斑，滚动时产生色相碰撞
2. **Sticky 壳子舞台**：首页中间段左侧（桌面）/ 上方（移动）固定 CSS 复刻壳子，右侧场景切换驱动 Tab/内容态
3. **插件瀑布帘幕**：全宽暗幕，多列不同视差速度 + 错列落入；卡片带 mint 描边光

## Motion

- 入场：`opacity + translateY(24px)`，0.55s `cubic-bezier(.22,1,.36,1)`
- 瀑布：列速差 0.12 / 0.2 / 0.28，卡片 stagger 40–80ms
- Sticky 场景：IntersectionObserver 切 `.is-on`
- 全部包在 `prefers-reduced-motion: no-preference`

## 页面范围

- `index.html` — 全量重做结构
- `index.html` — 主站（产品说明在此，不再单独维护 product 页）
- `download.html` — 共用新 token 与组件类

## 明确不做

- 不引入生成图 / 外链摄影
- 不引入 GSAP / 构建步骤（保持零构建静态站）
- 不用 gradient 文字填充做「AI 渐变标题」
