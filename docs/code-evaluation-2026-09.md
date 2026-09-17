# eNest 代码功能实现评估报告

> 评估时间：2026-09 · 范围：`src/main`、`src/preload`、`src/renderer`、`src/shared`、`eNest_plugin`、`docs`
> 方法：6 路并行子代理深读源码（只读），逐项对照 `AGENTS.md` / `ARCHITECTURE.md` 约定，证据均带 `file_path:line_number`

---

## 总览

| # | 评估维度 | 评分 | 一句话结论 |
|---|----------|------|------------|
| 1 | 插件全生命周期 | **6.5** | 运行时宿主扎实，产品闭环只完成约 60%（缺启用/禁用、远程更新、卸载 UI、Tab 持久化） |
| 2 | 动画档位（高中低）控制 | **7.0** | 主窗口档位闭环正确；生产 Orb 独立窗口完全脱离档位，是最大空洞 |
| 3 | 主题与插件动态主题 | **6.5** | 注册→广播→刷新链路通；卸载不清理主题包、无字号/中英分离字体 |
| 4 | 动画丰富度与性能 | **5.5** | 基建正确但动效偏「淡入上移缩放」三板斧，距高级组合有明确升级路径 |
| 5 | 小窗唤醒 / 插件查询 | **7.0** | Quick Launcher 架构分 8.5，体验分 5.5；骨架可用，缺最近/频次/模糊/图标 |
| 6 | 模块规范与注释 | **8.2** | 分层纪律与安全面优秀；类型双份、文档漂移、media 读盘过宽需收敛 |
| | **加权综合** | **约 6.8** | 工程底座健康，产品闭环与动效体验是下一阶段主战场 |

```mermaid
radar
  title eNest 六维评估
  axis 0,10
  series 生命周期: 6.5, 7.0, 6.5, 5.5, 7.0, 8.2
```

---

## 一、插件全生命周期（6.5）

### 已实现（扎实）

| 能力 | 证据 |
|------|------|
| 本地安装队列（并发 3）+ 校验 + 落盘 | `src/main/plugin/installQueue.ts:22-132`、`PluginInstaller.ts:60-137` |
| 打开 / 关闭 / 激活 Tab 会话 | `PluginHost.ts:135-236 / 242-295 / 301-340` |
| 生命周期状态机 | `PluginLifecycle.ts:51-110`（installed→opening→ready→active⇄background→closing→closed，含 crash） |
| 插件侧事件 `onEnter/onOut/onBeforeClose/onDestroy` | `pluginPreload.ts:273-325` |
| 卸载主进程 10 步（关 Tab → clearStorage → 删目录 → 重扫 → 事件） | `PluginUninstaller.ts:32-145` |
| 独立 partition 隔离 + 权限白名单 + sender 防伪造 | `constants.ts:58-60`、`pluginHandlers.ts:252-261` |
| `enest://` 协议路径穿越防护 + CSP | `pluginProtocol.ts:72-97,155-212` |
| 退出清理 `before-quit → destroyAll` | `src/main/index.ts:103-108` |

### 缺失 / 不完整

1. **启用 / 禁用：完全未实现** — 无 `enabled` 字段、无 IPC、无 UI（i18n 有文案无消费方）
2. **远程更新 / 下载链路断裂** — `marketClient` 解析了 `assetUrl`，但无下载逻辑；远程市场点「安装」会 `sample not found` 失败
3. **卸载无 UI 入口** — preload/IPC/事件全通，renderer **零调用** `uninstallPlugin`，整条链路成死代码
4. **Tab 会话不持久化** — `shellStore.tabs` 纯内存，重启后全部丢失
5. **半成品**：`ui.resize` 空实现；crash 后无恢复引导；`pluginReady` 用 300–400ms `setTimeout` 猜就绪

### 内存泄漏与性能风险

| 级别 | 问题 | 位置 | 建议 |
|------|------|------|------|
| **P0** | `destroyAll` fire-and-forget，退出竞态 | `PluginHost.ts:426-432` | 返回 Promise，`before-quit` preventDefault + await |
| **P0** | View 销毁偏弱，监听未显式移除 | `PluginHost.ts:264-279` | `removeAllListeners` 后再 close |
| **P1** | 多插件常驻无上限、无 LRU | `PluginHost.entries` | 设最大打开数；background 插件 `setBackgroundThrottling` |
| **P1** | `states` Map 关闭后不清理 | `closePlugin` | 回置 `installed` 或 delete |
| **P1** | `nativeTheme.on('updated')` 永不 off | `PluginHost.ts:417-423` | 提供 `dispose()` |
| **P2** | 协议每次 open 重挂、ack 并发覆盖 | `pluginProtocol.ts:187-212`、`PluginHost.ts:481-494` | 幂等注册 / 复用 Promise |

**结论**：产品级全生命周期约完成 **60%**。运行时宿主可扩展，但「启用/禁用、远程更新、卸载 UI、Tab 恢复」是硬缺口。

---

## 二、动画档位控制漏项（7.0）

### 体系现状（正确）

```
设置 general.animationLevel
  → useAnimationLevel 写 documentElement.dataset.anim
  → marketMotion d()/dy()/st()/ease() 按档缩放 GSAP 默认
  → CSS :root[data-anim=low|medium|high] 覆盖
```

证据：`SettingsStore.ts:50`、`useAnimationLevel.ts:29-56`、`marketMotion.ts:23-65`、`app.css:3024-3196`

**遵守规范**：`playHeroIn` / `animateCards` / 详情弹窗 / Splash / AmbientParticles（仅 high）/ 通知，均走档位化 API。

### 漏掉清单

| 级别 | 组件 | 问题 |
|------|------|------|
| **P0** | **Orb 独立窗口**（`orb-overlay.ts` + `orb-overlay.css`） | 跑在独立透明 BrowserWindow，**从不接收 `data-anim`**；弹簧/delay/锁定时长全部写死。违反 AGENTS 核心约定，且是高频交互面 |
| **P1** | Hero 打字机 `Typewriter` | 120/55/1600/320ms 硬编码，low 档仍循环打字（`MarketPage.tsx:25-67`） |
| **P1** | 轮播 autoplay | `AUTOPLAY_MS=3800` 固定，low 仍每 3.8s 强制滑动 |
| **P1** | low 通配误伤 spinner | `animation-iteration-count: 1 !important` 使 `.detail-spinner` 几乎静止（功能受损） |
| **P2** | high 弹窗路径魔法数 | `duration: 0.72` 等未走 `d()`（`marketMotion.ts:194-223`） |
| **P2** | `prefers-reduced-motion` 未全局接入 | 仅 Splash/弹窗检查；Hero/卡片/通知/轮播/打字机不尊重 |
| **P3** | 死代码 | `animatePageIn`/`toastIn/Out` 无调用方；`FloatingTabRail.tsx` 未挂载 |

**修复优先序**：Orb 同步 data-anim → spinner 白名单 → Typewriter/Carousel 节奏 → reduced-motion 全局映射 → 清理死导出。

---

## 三、主题设置与插件动态主题（6.5）

### 链路现状（完整闭环）

```
壳子 useTheme.applyToDom（预设 → packTokens → overrides）
  → shellApi.setTheme → SettingsStore ~/eNest/settings.json
  → theme-changed → pluginHost.broadcastTheme
  → themeAware 插件：executeJavaScript CSS 变量 + PluginEvent
  另有 enest://plugin/{id}/__enest_theme.css 静态通道

插件 enest.theme.register(ThemePack)
  → themePackRegistry 落盘 ~/eNest/themes/registry.json
  → theme-packs-changed → refreshPacks → 设置页下拉即时刷新
```

证据：`useTheme.ts:122-137`、`PluginHost.ts:375-414`、`themePacks.ts:52-72`、`pluginPreload.ts:141-160`

### 设置页可控项

| 可控项 | 状态 |
|--------|------|
| 明暗 / 跟随系统 | ✅ |
| 主题包选择 | ✅ |
| 12 个语义色 Token 微调 | ✅（但 rgba Token 会被归一成不透明 hex） |
| 壳子背景媒体 / Splash 背景 | ✅ |
| 字体预设 6 档 + 自定义字体上传（≤5MB） | ✅ |
| 动画档位 | ✅ |
| **字号 / 文本缩放** | ❌ 全库无用户字号设置 |
| **中英文分离字体** | ❌ 预设是合并栈，不可分别指定 |
| **等宽字体选择** | ❌ `--mono` 写死 |

### 插件动态主题能力

**已支持到「颜色 Token 级」双向通道**：themeAware 被动跟随 + `theme.register` 主动注册 + `preferredColorScheme` + 透明背景。pack tokens 是自由字典，理论上可写任意 CSS 变量（含 `--font`）。

**未支持 / 风险**：

1. **不能动态注册字体** — 无 `registerFont`；CSP `font-src 'self'` 不放行外链；tokens 写 `--font` 只改 family 名，二进制字体进不了插件 WebContents
2. **卸载不清理主题包**（高）— `PluginUninstaller` 完全没有 `themePackRegistry.remove`；卸载后幽灵包仍可选，dangling packId 静默回落
3. **`ThemePack.mode` 死字段** — 类型有、`applyPack` 从不读
4. **主/渲染预设漂移** — light `--bg` 主进程 `#f3f4f6` vs 渲染 `#f4f5f7` 等多处不一致
5. **`theme.register` 无权限门槛** — 恶意插件可无声明权限污染壳子配色（含 `--titlebar-h` 等结构 token）
6. **主题 UI i18n 半截** — `ThemeModeSelect`/`ThemeTokenEditor` 硬编码中文
7. **仓库无主题插件示例** — `eNest_plugin/` 无 `enest.theme.register` 范例

**修复优先序**：① uninstall 按 source 清 pack；② token 预设收 `@shared` 单源；③ 字号档 + 中英双槽位；④ Token 编辑器支持 alpha；⑤ i18n 接线；⑥ register 加权限；⑦ 补主题插件示例。

---

## 四、动画丰富度与性能（5.5）

### 能力盘点

| 场景 | 复杂度 | 备注 |
|------|--------|------|
| Splash 启动 | 中等 | 全项目最有编排感（描边→色块→脉冲→wordmark；high 加粒子） |
| Hero 入场 timeline | 中等 | 负偏移重叠，套路标准 |
| 列表 stagger | 简单 | 筛选整表重播，无 Flip |
| **页面切换** | **缺失** | `ShellLayout` 硬切；`animatePageIn` 已定义但从未调用 |
| Tab 切换 | 简单 | 仅新 Tab scale 0.92→1；关闭无重排动画 |
| 轮播 | 简单 | 仅 x 位移，无景深/拖拽/惯性 |
| 详情弹窗 | 中等偏上 | high 独有 3D + perspective |
| Hover | 简单 | 纯 CSS 2–6px 位移；high 扫光 |
| **设置页** | **极简** | 几乎无入场/指示器动画 |
| **安装流程** | **极简** | 进度条写 `width`（每帧 layout）；拖拽遮罩无过渡 |

**GSAP 使用面**：timeline / fromTo / stagger / autoAlpha / xyscale / strokeDashoffset / rotateX+perspective（high）。  
**完全未用**：ScrollTrigger、Flip、Draggable、MotionPath、CustomEase、SplitText、quickTo。  
依赖仅 `gsap@^3.12.5`，无官方插件。

### 性能

**好的**：几乎全走 transform/opacity；`will-change` 克制；卡片 `clearProps`；粒子 n≤28。

**隐患**：
1. 安装进度条 `width` 百分比 → 应改 `scaleX`
2. 拖拽遮罩 / 弹窗全屏 `backdrop-filter` 瞬时挂载
3. 筛选整表重播，列表到 50+ 会卡（无 Flip / 虚拟化）
4. `orb-rail transition: width` 触发布局

### 高级动画升级建议（优先级）

| 优先 | 建议 | 难度 | 收益 |
|------|------|------|------|
| ★★★★★ | **页面切换 View Transition + GSAP 共编**（启用闲置 `animatePageIn`） | ★★ | 感知差距最大 |
| ★★★★★ | **卡片→弹窗 FLIP 共享元素**（引入免费 Flip 插件） | ★★★ | awwwards 市场页标配 |
| ★★★★ | ScrollTrigger 首页滚动编排（Hero 视差 + 卡片入视口 stagger） | ★★ | |
| ★★★★ | Hero 标题字符级 stagger + 流光 | ★★ | |
| ★★★★ | 筛选 FLIP 重排（替代整表重播，更省） | ★★ | |
| ★★★★ | 轮播景深 + 拖拽惯性 | ★★ | |
| ★★★ | 设置页 FLIP 指示器 + 卡片入场（当前几乎零动效） | ★★ | 性价比极高 |
| ★★★ | 指针磁吸 + 光斑跟随（`gsap.quickTo`） | ★ | 成本低高级感强 |
| ★★★ | 安装全流程动画组合（进度 scaleX + 完成 confetti） | ★★ | |
| ★★★ | 主题切换色相过渡 + clip-path 扩散 | ★★ | |
| ★★ | 通知队列 FLIP + SVG 进度环 | ★ | |
| ★★★ | CustomEase 统一 motion token | ★ | 基建 |

**与 awwwards 级差距**：约 35–40%。缺口不在「有没有 GSAP」，而在**运动叙事密度与状态连续性**（硬切、整表重播、无共享元素、high 档只是同动画拉长加弹）。

**综合 5.5**：架构档位 8 / 丰富度 4 / 性能 7。用户「太简单了」反馈成立，有明确可分批落地的升级路径。

---

## 五、小窗唤醒与插件查询（7.0）

### 现状（骨架完整）

| 能力 | 状态 |
|------|------|
| 独立小窗 | ✅ 无边框 `BaseWindow` 720×420，skipTaskbar、alwaysOnTop、透明圆角，懒创建、失焦 80ms hide 不销毁（`createQuickWindow.ts:66-123`） |
| 全局热键 | ✅ 默认 `Alt+Space`，多 accelerator、失败回滚、设置页可录制（`quickHotkey.ts`、`QuickSettingsSection.tsx`） |
| 输入框 + 键盘导航 | ✅ ↑↓/Enter/Esc（`QuickLauncherApp.tsx`） |
| 命令聚合 | ✅ 内置 action + 插件 `features.cmds` + 三平台本地应用（`commandIndex.ts:118-145`） |
| 打分搜索 | ✅ 精确 100 > 前缀 80 > 包含 60 > alias 55-95（`commandIndex.ts:36-57`） |
| 空 query 默认列表 | ✅ 3 action + 6 插件 + 8 应用 |
| 插件联动 | ✅ 打开插件 + hide 小窗 + focus 主窗；IPC 七通道齐全 |
| 安全 | ✅ 本地应用走扫描缓存白名单 |

### 与 ztools 目标差距

| 维度 | 现状 | 差距 |
|------|------|------|
| 输入框美化 | 素列表 + token 色，**无图标、无分区、无毛玻璃分层** | 中 |
| 插件列表排序 | 空 query 硬编码 slice，无最近/频次 | 中 |
| 关键字匹配 | 子串 + alias，无 fuzzy / 拼音首字母 / description 加权 | 中高 |
| mini 插件内嵌 | `form:mini` 元数据就绪，仍开主窗 Tab | 高（二期） |

### 建议路径（约 3 个 PR）

1. **最近使用 + 频次**（性价比最高）：`settingsStore.general.quickLauncher.recent[]`，`handleOpen` 成功后写入，空 query 按 ts+count 排序
2. **模糊匹配升级**：只改 `scoreItem`，加子序列 fuzzy + 可选 `tiny-pinyin`
3. **输入框美化**：`QuickCommand` 增 `icon?`；`app.getFileIcon` + 插件 icon；quick.css 加图标列、kind 分组标题、backdrop 分区、active 左侧 accent 条（窗口已透明底）
4. **二期**：`form:mini` 插件挂到 Quick 窗 contentView

**综合 7.0**：架构 8.5 / 体验 5.5。补齐 1–3 后可达 ztools 准生产形态。

---

## 六、模块规范与注释（8.2）

### 优秀项

- **三端职责遵守度高**：renderer 无 electron/node；main 无 React；shared 无运行时依赖
- IPC 通道唯一源在 `@shared/types/ipc`
- **零** `any` / TODO / FIXME / `@ts-ignore` / 跨三层 `../../../`
- 模块首注释固定四段（模块名/职责/调用方/关键依赖），关键路径有 why 注释
- 命名一致（PascalCase 类、camelCase 工厂、`namespace:kebab` IPC）
- `strict: true`；权限表 + sender 校验 + 协议穿越防护 + Markdown 无 `dangerouslySetInnerHTML`

### 违例与问题

| 项 | 数量 | 说明 |
|----|------|------|
| 单层 `../` 跨子目录 | 20 | 可跑 `scripts/rewrite-imports.mjs` 一次清掉 |
| 类型双份维护 | 多处 | `EnestShellApi`≈`ShellApi`；`PickFileOptions` 等 preload/renderer 各一份；mock 缺 `quickLauncher` |
| eslint 配置 | **缺失** | `npm run lint` 无配置文件 |
| 文档漂移 | 多处 | 根 ARCHITECTURE 失效链接；TITLEBAR 仍写 48（代码 36）；安装路径仍写 userData（实际 `~/eNest`）；forge vs builder；哈希校验有文档无实现 |
| 仓库杂物 | 2 张 generated PNG ≈2MB | 未 gitignore |
| 空目录 | `src/shared/constants/` | 与 `constants.ts` 并存易误导 |

### 安全风险

| 级别 | 问题 | 位置 |
|------|------|------|
| **中高** | `enest://media` 允许整个用户主目录，插件可读任意文件 | `pluginProtocol.ts:114-124` |
| 中 | default-session media 恒走 DEV_CSP | `pluginProtocol.ts:160` |
| 中 | `sandbox: false` 全开 | 各窗口创建处 |
| 中 | `theme.register` 无权限 | 见第三节 |

**优先修 5 件事**：① 类型收 `@shared`；② 文档对齐；③ 收窄 media 读盘；④ 清相对路径 + 补 eslint + 清杂物；⑤ 落地/删除 `ui.resize`，评估 sandbox，事件驱动替换 magic timeout。

---

## 七、跨维度共性问题（合并优先级）

### P0 — 应立即处理

1. **Orb 独立窗口脱离动画档位**（体验 + 约定双违）
2. **退出竞态 `destroyAll` 不 await**（资源清理）
3. **`enest://media` 读盘范围过宽**（安全）
4. **卸载主题包无 GC**（功能闭环破口）

### P1 — 近期冲刺

5. 卸载 UI 入口（接上已有 IPC）
6. 启用/禁用插件
7. 远程市场下载/更新链路
8. Tab 会话持久化
9. Quick：最近使用 + 模糊匹配 + 图标美化
10. 字号档 + 中英双字体槽位
11. low 档 spinner 白名单 + Typewriter/Carousel 接档
12. 类型/契约收 `@shared` + 文档同步

### P2 — 动效升级批次（配合设置档位门控）

13. 页面切换动画（启用 `animatePageIn`）
14. 设置页 FLIP 指示器 + 卡片入场
15. 筛选 Flip / 弹窗共享元素（引入免费 Flip 插件）
16. 指针磁吸 + 安装流程动画 + 主题切换过渡
17. ScrollTrigger 首页滚动编排
18. 进度条 `width`→`scaleX`

### P3 — 工程卫生

19. 清理死代码（`FloatingTabRail`、`toastIn/Out`、`ORB_RAIL_INSET*`、空目录）
20. 补 eslint；`sandbox: true` 可行性评估；`ui.resize` 落地或删除

---

## 八、建议落地节奏

| 阶段 | 目标 | 预估 |
|------|------|------|
| **本周补丁** | P0 四项 + spinner 白名单 + 卸载 UI | 1–2 天 |
| **闭环冲刺** | 启用/禁用 + 远程安装/更新 + Tab 恢复 + 主题 pack GC + 字号/双字体 | 3–5 天 |
| **体验升级 1** | Quick 三项增强 + 设置页/页面切换/安装动效 | 3–4 天 |
| **体验升级 2** | Flip/ScrollTrigger/磁吸/主题过渡（均 high 档门控） | 4–6 天 |
| **工程收敛** | 类型单源、文档同步、eslint、media 收窄、sandbox 评估 | 2 天 |

---

## 附录：子代理分报告索引

本报告由 6 个并行评估代理合成，维度分别为：

1. 插件全生命周期（含内存泄漏分级）
2. 动画档位违例清单
3. 主题链路与插件动态主题
4. 动画丰富度 / 性能 / 15 条升级建议
5. Quick Launcher 与 ztools 差距
6. 模块规范 / 注释 / 安全

各维度完整证据链见上文 `file_path:line_number` 引用。
