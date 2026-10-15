# 桌面首页、账号与插件启动优化

日期：2026-10-14。本轮直接在现有工作区修改，保留此前背景动效、独立窗口与其它未提交改动；未执行 Git 提交或推送。

## 本轮交付

| 用户反馈 | 最终行为 |
| --- | --- |
| 精选截图左侧被斜线挡住 | 按后续反馈保留中间斜切分隔，斜切只作用于背景装饰；截图放在斜边右侧安全区，以完整矩形和 contain 展示，可继续查看大图。 |
| 个人资料混在通用设置，需要浏览器登录 | 独立个人资料 Tab，统一登录方式按钮、浏览器等待/重开/取消、账号和退出状态。GitHub 为首个提供方，无 Client ID 输入框；通过宿主适配器和通用事件扩展后续方式。 |
| 低档完全不动 | 内置程序背景以 12 FPS、0.35 倍速度轻微运动；系统减少动态设置仍为静态。 |
| 氛围色与背景动效互斥或延迟 | 同时合成，先更新本地画面再异步保存；启动、主窗、Quick、独立窗口同步，关闭动效时也保留氛围色。 |
| 开发者页面杂乱、DevTools 无响应 | 自动识别匹配的开发服务或本插件 dist，移除预览方式、HMR 标签、调用跟踪。DevTools 修复内置调试页面的加载；输出启动日志与插件控制台日志。 |
| 移出调试插件不应删除数据 | 独立移出接口：关闭调试实例并去除开发注册，保留源码、正式安装包及插件数据。 |
| 数据库和 SSH 的设置权限项过多 | 移除这两个插件设置页中的“系统与隐私权限”控制区，保留业务设置入口。 |
| SSH 白屏，没有启动过渡 | 开发端口身份校验避免把其它项目当插件加载，自动使用正确构建产物；加载时原生 View 暂隐藏，壳显示轻量转圈和“正在启动”，加载完成再显示。修复活动 Tab ID 与视图 ID 的不一致。 |
| 桌面搜索缺少应用/插件能力、空状态拥挤 | 复用 Quick 的静态、补充和动态插件搜索，添加市场结果；支持本机应用、已安装插件、市场、快捷操作筛选及键盘选择。插件在主窗打开，保留动态命令与载荷；空状态的说明和按钮独立排列。 |

## 验证

- 最终 `npm run typecheck` 与 `npm run build` 通过。
- `node --test src/main/auth/*.test.mjs`：8 项通过。使用真实 loopback HTTP 与模拟 GitHub 上游，覆盖 state、重放、并发、取消、资料持久化同步异常、浏览器打开失败、请求中止、旧刷新不恢复已退出账号、公开配置和提供方 ID 校验。
- IPC/设置隔离/壳状态专项组合 19 项通过；开发入口、插件宿主、移出保留数据与 DevTools 请求策略的专项组合 86 通过、1 项原有 opt-in 测试跳过，见 [开发者验收](plugin-developer-validation-2026-10-14/README.md)。
- `homeSearchModel.test.mjs` 6 项通过；实际浏览器验证打开动作、类型筛选、旧响应丢弃、输入法 Enter、补充结果保留选中项、动态载荷以及失败重试。
- 最终构建的真实 Electron 开发者 smoke 1/1 通过：真实 SSH 工作台初始化、开发日志、DevTools 窗口、移出保留数据、重新识别开发服务，以及加载中/加载后原生视图切换。未连接远端 SSH 服务器。
- 最终构建的真实 Electron 首页搜索 smoke 1/1 通过：真实 QQ/QQMusic 扫描与图标，系统打开 QQ 成功；静态插件入口与动态 provider 的 code/type/payload 完整传递，在主 BaseWindow 中显示；未安装的市场计算器结果正确进入详情。
- 个人资料实际浏览器检查：独立 Tab，通用设置无账号表单；明暗主题正确，900px 窗口无横向溢出，页面无异常。未配置版本显示 GitHub 暂不可用。
- 背景真实 WebGL/React 控件与原生跨窗口验证见 [背景验收](background-effects-validation.md)。最终合并构建的原生背景 smoke 通过，数据根与 userData 均隔离。

可重跑的原生测试均需先在仓库根目录执行 `npm run build`：

```sh
ENEST_BACKGROUND_SMOKE=1 node --test src/main/window/backgroundEffects.smoke.test.mjs
ENEST_DEVELOPER_SMOKE=1 node --test src/main/plugin/pluginDeveloper.smoke.test.mjs
ENEST_HOME_SEARCH_SMOKE=1 node --test src/main/launcher/homeSearch.smoke.test.mjs
```

背景测试需要 ffmpeg；开发者测试需要真实 SSH 插件 dist；首页测试会扫描本机应用，设置 `ENEST_HOME_SEARCH_APP=QQ` 才实际打开该应用。测试使用独立 profile，不修改用户配置和业务数据。

## GitHub 接入边界

用户已确认尚未注册 OAuth App，本轮完成登录页、默认浏览器 PKCE 授权、本机回调、账号存储和服务端交换示例。未声称已完成真实 GitHub 账号授权。公开 Client ID 与交换 URL 由发布方一次性配置；Client Secret 仅放在服务器，不进入桌面包。配置步骤和可运行示例见 [账号接入说明](account-login.md)。

本轮涉及主进程与 preload，已有开发实例需重启 `npm run dev` 后使用完整更新。没有重启用户正在使用的实例，也没有停止占用 5173 的其它项目服务。

## 界面证据

目录：`/Users/haijun/.codex/visualizations/2026/10/14/01a13922-b1dd-7892-975d-50d41dd5f989/`。

- `profile-light-final.png` / `profile-dark-final.png` / `profile-dark-900-final.png`
- `homepage-featured-stable-light.png` / `homepage-featured-stable-dark.png`
- `homepage-search-qq.png` / `homepage-search-empty.png`
- `profile-browser-qa.json` / `homepage-search-browser-qa.json` / `homepage-search-failure-qa.json`
- `homepage-native-app-search.png` / `homepage-native-provider-search.png` / `homepage-search-native-qa.json`

浏览器截图用于布局检查，模拟搜索条目不等同于真实应用扫描。原生搜索与 SSH 的验收单独记录。

### 后续调整：保留斜切分隔

按用户反馈恢复精选卡片中间的斜切造型；只裁背景层，截图左侧内缩斜切宽度加 12px，保持完整截图。1200/900px 的明暗主题共 4 组真实浏览器检查通过，全部实际打开/关闭大图，未遮挡、缩放裁切或偏移。`npm run typecheck` 与定向差异格式检查通过。截图 `homepage-diagonal-card-final.png`，证据 `homepage-diagonal-qa.json`，均在上述工作产物目录。
