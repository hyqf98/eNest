# 窗口历史、置顶与惰性恢复验证

2026-10-14，macOS arm64 / Electron 44.4.3。此次行为替代最初“独立窗统一恢复到主窗口”的方案：主窗 Tab 和独立窗口各自恢复，全部等待用户主动打开后才加载插件。

> 历史验收快照：下文及同名 JSON 保留当日实际结果，包括旧主题测试失败，不代表当前版本状态。现行启动与外观边界见 [THEME_STANDARD.md](THEME_STANDARD.md)；不要依据此处历史失败重新引入已移除的主题 store。

## 已实现与验证

- 收回主窗 / 小窗改成图标，带原生 title 提示和 aria-label；置顶按钮依据原生状态更新提示、强调色和 aria-pressed。窄窗口与 macOS 控件布局已渲染检查。
- 保存独立窗正常 DIP 位置和尺寸、布局、置顶、最大化与最小化状态；保存主窗口位置和尺寸。负坐标和损坏历史由纯逻辑回归覆盖，实际重启验证正常坐标与原生状态。
- 隔离进程真实退出后，恢复 3 个独立窗和 1 个主窗 Tab：`logicalTabs=1, lazyDetached=3, restoringDetached=0, entries=[]`。包括上次激活的主窗 Tab，启动插件实例为 0；独立窗口保留原 shell / quick 布局。
- 聚焦、还原、置顶不触发惰性加载；关闭未加载窗删除历史且不创建实例；显式打开仅加载选中插件；普通启动入口复用原独立窗；收回清除 detached 历史。
- 连续 20 次往返保留存活插件 wcId / generation / 页面身份，两个独立 Quick 输入隔离。命令驱动的 1/6/10/20 逻辑插件矩阵和关闭后资源清理继续通过。
- 补充并通过恢复并发限制、关闭 / 卸载 / 退出竞争、加载中收回、关闭后重开防过期迁移、输入不被置顶等元数据覆盖的回归。
- 窗口移动期间合并历史更新；只写发生变化的设置字段。历史落盘不再向所有独立窗广播外观，已用回归确认。

## 工程检查

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | node + web 通过 |
| `npm run build` | 通过，保留现有动态 / 静态导入警告 |
| 窗口 / Host / 输入 / 设置边界 / renderer 定向回归 | 117 项：116 通过、1 项原生 UI 按默认跳过 |
| `ENEST_DETACHED_UI_SMOKE=1` 独立窗 UI 回归 | 11 / 11 通过，含真实 Electron HTML/CSS |
| `ENEST_DETACHED_SMOKE=1` 独立窗原生回归 | 1 / 1 通过，含完整退出重启及最大化 / 最小化 / 置顶恢复 |
| `ENEST_QUICK_SMOKE=1` Quick 原生回归 | 1 / 1 通过，首页、搜索、插件尺寸、Esc 与迁移 |
| `git diff --check` | 通过 |
| 全量 `src/**/*.test.mjs` 快照 | 493 项：473 通过、16 跳过、4 项非本功能失败 |

全量失败：`src/shared/pluginCommands.test.mjs` 的安装夹具缺少当前 manifest 必需字段；`src/renderer/hooks/useTheme.test.mjs` 的 3 项主题夹具未提供 `@shared/backgroundEffects` 模块，读取 `DEFAULT_BACKGROUND_EFFECT` 失败。本次未调整这些测试或放宽生产校验。全量运行期间工作区另有背景效果改动；此处记录实际运行快照，不能代表全量通过。

## 证据与范围

原始重启证据：`/var/folders/h8/10lgg_wn1xg5h9yvsjlgcbrr0000gn/T/enest-detached-artifacts-YZmCqA/detached-window-evidence.json`。同目录的 `restored-lazy-chrome.png` 已查看，显示图标按钮、已置顶状态与“点击打开插件”占位。

Quick 原始证据：`/var/folders/h8/10lgg_wn1xg5h9yvsjlgcbrr0000gn/T/enest-quick-smoke-artifacts-b4sGl7/quick-window-evidence.json`。

日志：`/tmp/enest-window-history-typecheck.log`、`/tmp/enest-window-history-build.log`、`/tmp/enest-window-history-focused.log`、`/tmp/enest-window-history-ui.log`、`/tmp/enest-window-history-smoke.log`、`/tmp/enest-window-history-quick.log`、`/tmp/enest-window-history-all-tests.log`。

Windows 实机以及真实物理鼠标跨屏 / 混合 DPI / FPS 指标仍未验收。本次原生自动测试用宿主命令触发迁移，并仅在隔离测试进程内移除 Quick blur 隐藏监听，不能替代真实失焦或物理拖动性能验收。恢复的是窗口与布局历史，插件内容按其自身数据持久化机制重新加载。

代码已保存，原工作区修改保留，未提交或推送。
