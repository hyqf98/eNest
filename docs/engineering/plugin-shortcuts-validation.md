# 插件快捷键统一设置与启动链路验收

日期：2026-10-14。平台：macOS 27.0（26A428）、arm64、Electron 44.4.3、Node 22.22.1。

## 已发现问题的修复

| 原问题 | 修复后的行为 |
| --- | --- |
| 原生注册失败仍返回成功 | 保存返回实际注册结果；冲突提示占用方，保留原绑定，不提供接管 |
| 修改配置时全量重注册 | Quick、用户绑定、插件运行时快捷键统一管理；按归属差量更新，单改启动位置不重新注册 |
| 插件误注销其他功能的键 | 运行时注销必须匹配调用实例的归属，不能释放 Quick 或其他插件的绑定 |
| 取消后迟到启动、连续按键抢位置 | 共用启动服务；合并同目标请求，以最后一次目标为准，隐藏、关闭和迁移修订使旧请求失效 |
| 小窗直启回退搜索、加载状态残留 | 先准备 Quick 文档，再提交原生展示；补齐加载完成／失败事件，保留外部粘贴目标 |
| 休眠或独立窗迁移失败破坏原状态 | 延迟首次插件页面加载；呈现或原生挂载失败时释放此次准备的实例，恢复源模式、休眠身份和窗口 |
| 磁盘失败仍报告保存成功 | 插件绑定与 Quick 呼出键通过专用同步持久化提交；失败回滚注册和配置；原键被抢占时撤销未保存的新键并显示未生效原因 |

## 设置能力与数据契约

- 设置 → **快捷键**：上方为 Quick 呼出键，下方为插件绑定；两个开关独立。
- 同一插件支持多条绑定，逐条选择小窗口或主窗口，支持录制／输入、编辑、删除、启停、立即启动及插件筛选。未保存草稿不注册。
- “立即启动”遵从该条绑定的位置；绑定关闭时仍可手动启动，插件禁用或缺失时不可启动。
- 插件详情跳转到快捷键页并筛选当前插件；搜索触发词与搜索启动偏好保持原语义。
- `pluginShortcuts` 保存 `{ id, pluginId, accelerator, mode, enabled }`。生效、暂停、冲突、禁用、缺失状态只保存在运行时。
- 旧 `pluginLaunch[id].hotkey` 一次性迁移，沿用旧 mode（缺省 quick），清除旧 hotkey，保留 mode／aliases；重复加载不新增绑定。
- 专用 IPC 覆盖查询、保存、删除、冲突探测、启动、录制开始／结束；主进程、preload、共享类型、事件与浏览器 mock 一致。普通设置 IPC 不能绕过快捷键服务。
- 录制暂停 eNest 自身快捷键，在主键释放、Esc、失焦、销毁或 30 秒超时后恢复；令牌属于实际调用文档，恢复失败显示冲突。
- 插件禁用释放键并保留配置；重新启用验证注册；卸载成功清理关联绑定；历史缺失项可以删除。
- 注册不预加载插件，不增加后台轮询。热启动复用同一 WebContentsView；沿用 Host 的任务保护、单实例和空闲休眠策略。

## 验证范围

### 定向自动回归

覆盖规范化和等价冲突、系统占用、运行时所有权、原生注册竞争、换键失败、真实 SettingsStore 写入失败、回滚时原键丢失、批量删除恢复、录制中断及超时、无关配置／位置变化不重注册、迁移、重载、mock 持久化、IPC 来源限制，以及启动服务和 Host 的生命周期竞争。

Host 测试包含冷／热／休眠、任务保护、独立窗收回、源／目标模态阻塞、准备途中关闭、不同目标连按、多个插件争用 Quick、原生展示与挂载失败后的状态恢复。

最终命令和结果见下方“最终结果”。这组测试为定向回归，不代表运行了仓库所有测试。

### 浏览器界面

`ENEST_SHORTCUT_UI_SMOKE=1 node --test src/renderer/components/shortcuts.smoke.test.mjs`

使用浏览器操作设置页，验证录制释放、同插件双绑定、等价冲突拒绝、编辑、开关、重载、筛选和删除；1200px／800px 宽度检查无字段溢出、无运行错误。浏览器 mock 明确标注不能注册操作系统快捷键。

### 原生 Electron

`ENEST_SHORTCUT_SMOKE=1 ENEST_SHORTCUT_SYSTEM_INPUT=1 node --test src/main/window/pluginShortcuts.smoke.test.mjs`

每次使用隔离数据根和 userData，安装两个测试插件，退出后清理测试配置。没有操作用户的正式插件数据。

- 在原生 Chromium 设置页录制并保存组合键（录制输入使用 `webContents.sendInputEvent`）。
- 使用 macOS System Events 实际发送 Control + Option + Command + 1／2，由系统 globalShortcut 回调启动插件，不经过搜索。
- 验证主窗最小化、隐藏时仍可启动，Quick／主窗迁移保留 wcId、页面 identity 和输入内容，独立窗按绑定收回。
- 实际切换 Classic／Orb；快速发出小窗 → 主窗 → 小窗请求，最终位置正确且只保留一个插件 renderer。
- 注册 1／10／50 条绑定不额外启动插件；禁用／启用状态正确；真正退出并重启后绑定仍存在且未预加载插件；卸载清理绑定。
- Quick 呼出键保存与冲突回滚、重启保持、关闭 Quick 不影响 50 条插件绑定。

另运行已有原生 Quick 与独立窗回归，检查 Quick 几何／Escape、跨宿主迁移和独立窗往返。原生设置截图为 shell WebContents 截图；已有 Quick 回归截图为操作系统窗口合成截图，二者不混用。

## 性能口径

每档绑定数分别采样：Quick 已显示时热启动 20 次，Quick 隐藏后热启动 20 次，关闭插件并等待 renderer 销毁后冷启动 5 次。按 nearest-rank 计算 P50／P95，因此 5 次冷启动的 P95 为该组最大值。

耗时从公开启动 IPC 调用开始，到原生 View 可见且 fixture ready 为止，包含 IPC 与观察开销；隐藏恢复还包含外部粘贴目标捕获。它不是物理按键到像素的端到端延迟。冷启动样本复用已经创建的 Quick 窗口；首次创建 Quick 的耗时另记。

没有采集旧实现同机对照，不能据此宣称性能提升百分比。绑定数量比较只用于确认本轮样本中没有随 1 → 10 → 50 条绑定增长的耗时趋势。

## 最终结果

| 检查 | 最终结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过；既有混合静态／动态 import 警告保留在日志 |
| 定向回归 | **174/174 通过**，0 跳过 |
| 浏览器设置流程 | **1/1 通过** |
| 原生快捷键／多绑定／重启／性能 | **1/1 通过**，真实 macOS 系统输入已启用 |
| 原生 Quick／独立窗回归 | **2/2 通过**；20 次独立窗迁移、16 次重复 Escape |
| `git diff --check` | 通过 |
| ESLint | 未执行：仓库当前没有 ESLint 配置文件 |

| 绑定数 | Quick 已显示热启动 P50 / P95 | 隐藏后热启动 P50 / P95 | 插件冷启动 P50 / P95 |
| --- | --- | --- | --- |
| 1 | 13.99 / 39.17 ms | 56.36 / 92.91 ms | 193.58 / 207.66 ms |
| 10 | 13.74 / 31.79 ms | 53.29 / 552.14 ms | 187.31 / 196.40 ms |
| 50 | 13.13 / 28.78 ms | 60.46 / 561.39 ms | 164.06 / 188.77 ms |

首次创建 Quick 并冷启动 fixture：**492.90 ms**。最终结果没有出现绑定数增加导致中位耗时增长；注册及重启时没有额外插件 renderer，热迁移复用同一实例。隐藏后恢复仍出现 **552–561 ms P95** 的长尾；之前复测也出现约 550–670 ms，尚未通过专项分析确定来源，不能将已显示窗口的约 13–14 ms 中位数推广到所有启动情况。

定向回归命令：

```bash
node --test \
  src/shared/accelerator.test.mjs \
  src/main/hotkey/*.test.mjs \
  src/main/ipc/shortcutHandlers.test.mjs \
  src/main/ipc/ipcSecurity.test.mjs \
  src/main/settings/pluginShortcuts.test.mjs \
  src/main/settings/quickPreferences.test.mjs \
  src/main/settings/pluginSettingsBoundary.test.mjs \
  src/main/launcher/pluginLauncher.test.mjs \
  src/main/launcher/quickSearch.test.mjs \
  src/main/plugin/PluginHost.test.mjs \
  src/main/window/quickRestore.races.test.mjs \
  src/main/window/quickWindow.geometry.test.mjs \
  src/renderer/components/shortcutCapture.test.mjs \
  src/renderer/services/shortcutMock.test.mjs \
  src/renderer/stores/shellStore.test.mjs

ENEST_QUICK_SMOKE=1 ENEST_DETACHED_SMOKE=1 node --test --test-concurrency=1 \
  src/main/window/quickWindow.smoke.test.mjs \
  src/main/window/detachedPluginWindows.smoke.test.mjs
```

已归档证据：

- [本轮 31 个功能源码文件的 SHA-256](plugin-shortcuts-validation/source-sha256.json)（工作区含既有修改，未创建提交）
- [原生快捷键与性能 JSON](plugin-shortcuts-validation/native-shortcuts.json) · [原生执行日志](plugin-shortcuts-validation/native-shortcuts.log)
- [原生设置截图（含占用提示）](plugin-shortcuts-validation/settings-native.png)
- [浏览器 1200px 截图](plugin-shortcuts-validation/settings-browser-wide.png) · [800px 截图](plugin-shortcuts-validation/settings-browser-narrow.png) · [浏览器日志](plugin-shortcuts-validation/browser-ui.log)
- [174 项回归日志](plugin-shortcuts-validation/targeted-tests.log) · [类型检查](plugin-shortcuts-validation/typecheck.log) · [构建日志](plugin-shortcuts-validation/build.log)
- [Quick／独立窗原生回归日志](plugin-shortcuts-validation/native-window-regression.log) · [Quick 原生窗口证据](plugin-shortcuts-validation/quick-native/quick-window-evidence.json) · [Quick 插件窗口合成截图](plugin-shortcuts-validation/quick-native/quick-expanded.png)


## 未覆盖项与使用方式

- Windows／Linux 未做原生交互验收；组合键规范化的跨平台分支只有自动测试证据。
- 原生模态阻塞、休眠恢复失败、磁盘失败和注册竞争使用故障注入回归；没有真实破坏磁盘或人工触发全部系统对话框组合。
- 30 秒看门狗及录制销毁竞争使用自动测试；原生录制验收验证了正常录制和恢复。
- 性能测试使用轻量 fixture，不能代表重型插件自身初始化耗时，也不替代长时间 CPU／内存分析。
- 本轮没有提交或推送 Git；保留工作区原有未提交修改。主进程／preload 已变更，日常开发实例需要重启 `npm run dev` 后查看新设置。
