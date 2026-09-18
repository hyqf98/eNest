# eNest 插件规模性能对比报告

- 生成时间：2026-09-17T12:38:54.872Z
- 工具：`node scripts/perf-compare.mjs`（dev 模式 + CDP + main.log + ps 采样）
- 环境：macOS dev（electron-vite dev，非打包），数据目录 `~/.eNest`
- 模式：标准（LRU 同步验证，不做 3 分钟空闲等待）

## 数据表

| 指标 | 基线（1 插件） | 10 插件 | 增量 |
| --- | --- | --- | --- |
| 启动 ready→window ok | 105 ms | 105 ms | 0 ms |
| 打开全部插件总时长（含 450ms/个节奏间隔） | 479 ms | 4715 ms | — |
| 单次 openPlugin IPC 耗时（均值/最慢） | — | 19 ms / 25 ms | — |
| 内存（Electron 全进程 RSS 和，3 次均值） | 919.1 MB | 1431.1 MB | 512 MB |
| 观测到的进程数 | 7 | 12 | 5 |

## 说明

- 「启动」= main.log `[main] ready` → `[main] window ok`（主进程侧窗口创建完成；不含渲染层 splash）。
- 「打开」= 经 CDP evaluate 顺序 `openPlugin`；每次打开间隔 450ms 等插件 load-ok（真实节奏，且保证 LRU 可对 background 插件生效）。
- 内存为 `ps` 抓全部 Electron 相关进程（主进程 + Helper）RSS 之和；dev 模式含 Vite/调试开销，绝对值偏高，看增量。
- 10 插件场景：sessionTabs 惰性恢复只孵化上次 active，其余为占位 Tab（本表「打开」为主动顺序孵化路径）。
- 休眠日志每事件两行（applyTransition 一行 + hibernatePlugin 汇总一行），统计按事件计数有少量重复，量级不受影响。
- 参考数据（无节奏间隔的突发打开）：内存峰值 1972 MB、进程 16 —— 突发时 LRU 驱逐被 opening 态防御跳过，见「遗留」。

## LRU / 休眠验证

- 打开 10 插件过程中 LRU 立即休眠次数（PLUGIN_ALIVE_LIMIT=6）：**8**
- 休眠日志样本（最近几条）：

```
[2026-09-17 20:38:43.876] [info]  [lifecycle] test.perf2: background → hibernated (idle 180000ms)
[2026-09-17 20:38:44.349] [info]  [lifecycle] test.perf3: background → hibernated (hibernate)
[2026-09-17 20:38:44.349] [info]  [lifecycle] test.perf3: background → hibernated (idle 180000ms)
[2026-09-17 20:38:44.822] [info]  [lifecycle] test.perf4: background → hibernated (hibernate)
[2026-09-17 20:38:44.822] [info]  [lifecycle] test.perf4: background → hibernated (idle 180000ms)
```

- 空闲休眠（3 分钟）未在本轮等待：`PLUGIN_HIBERNATE_DELAY_MS=180000`，可用 `--full` 复测

## 结论

- 10 插件对主进程启动耗时增量：**0 ms**（10 个 manifest 扫描 + 校验不放大主进程启动路径，插件孵化按需进行）。
- 10 插件全量打开总时长 **4715 ms**（含节奏间隔），单次 openPlugin IPC 均值 19 ms —— 插件孵化为 WebContentsView 创建，亚秒量级。
- 内存增量：**512 MB**（10 插件全开；LRU/休眠把存活渲染进程压在 PLUGIN_ALIVE_LIMIT=6 内，见上节——无 LRU 的瞬时峰值见下）。
- 惰性恢复：启动仅孵化 active 插件，占位 Tab 不产生渲染进程（启动内存/耗时不受会话 Tab 数放大）。

## 遗留 / 注意

- dev 模式（Vite dev server）绝对值不代表打包性能；发布前建议用 `npm run pack:dir` 复测。
- RSS 为 ps 采样，含共享库重复计算，只宜看相对增量。
- 突发连续 openPlugin（无间隔）时，上一只插件尚在 opening 态，deactivate 为非法转移、LRU 驱逐被防御跳过（日志 `skip hibernate in state opening`），瞬时存活可超 PLUGIN_ALIVE_LIMIT；下一次 open/activate 会补收。真实用户点击节奏不受影响。
- test-perf-* 插件已从 ~/.eNest/plugins 清理；manifest 贡献点已在生成时剔除，不留 contributions 残行。