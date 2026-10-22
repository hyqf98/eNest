# 插件内存监控

入口：设置 → 通用 → 插件内存监控。由主进程单任务串行采样，间隔 5 秒；设置页只在可见时读取快照，不承担告警判断。关闭监控会停止系统采样和内存提醒。

## 指标与归属

- macOS 优先使用固定原生辅助程序的 `proc_pid_rusage` / `ri_phys_footprint`，包括压缩内存负担；辅助程序不可用时明确降级为 RSS。
- Windows 使用系统 PowerShell / CIM 的 PrivatePageCount；Linux 使用 `/proc` 的 VmRSS + VmSwap。所有跨端字段均为 bytes，显示为 MiB。
- 只将 WebContents、宿主创建且登记的后台/运行时/开发进程和可验证的后代关联给插件，不按进程名称猜测，不查询或上报进程命令行。
- 按唯一 PID 去重汇总。多插件或宿主共用的进程单列为共享，不平均分摊，也不将插件行相加。GPU/宿主进程单独显示，不能精确分摊到插件。
- 采样失败是 `null/unavailable`，不是零。RSS 降级在界面显式标识。采样峰值是本次宿主会话观察到的关联进程峰值，不是任意历史峰值，也不能证明两次采样之间没有瞬时尖峰。
- 已知后代使用 PID + 启动时间跟踪；退出后 PID 重用不会继承旧归属。只读监控不赋予对任意发现 PID 的终止权限。

## 设置与提醒

宿主设置键：`general.pluginMemoryMonitor`，完整对象为：

```json
{ "enabled": true, "alertsEnabled": true, "warningThresholdMiB": 512 }
```

阈值范围 128 至 8192 MiB。普通超限持续至少 10 秒才提醒；达到 `max(2 × 阈值, 1024 MiB)` 时立即提醒。同一插件 5 分钟内不重复通知，首次升级为严重异常允许提前通知。使用现有 `showNotification`，跟随通用通知位置，不要求插件 `notify` 权限。异常 PID 与测量值写入宿主日志，不持续积累采样历史。

## 关闭与释放

显式关闭会立即禁止新资源创建、abort 运行中任务、停止受管后台/开发进程与后台计时、摘除视图。仅保留有界的 beforeClose 保存窗口，随后销毁 WebContents，执行 scope disposers，关闭插件 session 的连接并清除宿主文件缓存/临时会话。持久化插件数据、用户文件和登录状态不因关闭而删除。切换 Tab、隐藏窗口和会话保留的内部重载不等同显式关闭。

关闭 API 等待真实退出；超时或清理失败会返回失败并提示，不把“已发终止信号”当成释放完成。登记的 retiring 进程保留到真实退出，禁止旧实例的延迟回调误停新实例。外部用户手动启动的服务不接管、不终止。已脱离受管进程树且无法安全确认身份的进程不能盲目强杀。

当前使用的插件首页由主题工作区管理，监控可见但不能在普通插件关闭按钮中关闭，需先切换主题。Chromium 共享进程及 GPU 缓存可能仍被其他页面使用；释放插件资源不等于系统内存数字立即归零。

## 桥接

`ShellGetPluginMemorySnapshot` 为受信任壳 IPC；`getPluginMemorySnapshot(): Promise<PluginMemorySnapshot>` 在 shared DTO、preload、renderer、mock 之间复用。浏览器预览明确标为不可采样，不伪造数据；旧宿主缺少 API 时提示重启。新增主进程/preload/原生辅助程序改动需重启开发应用生效。
