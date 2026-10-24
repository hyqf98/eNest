# 后台步骤计划

eNest 0.2.2 的 `enest.deadlineTasks` 提供插件私有的持久化步骤调度，不实现番茄钟、专注/休息、周期预设、统计或历史编辑。以上业务由番茄钟插件自己的代码实现。

```js
await enest.deadlineTasks.start({
  id: 'my-task',
  steps: [{ id: 'step-1', durationMs: 60_000, data: { kind: 'plugin-defined' } }],
  repeat: false,
  autoAdvance: false
})
const off = enest.deadlineTasks.onChange(async ({ taskId }) => {
  const { task, receipts } = await enest.deadlineTasks.get(taskId)
  // Render plugin-defined state and reconcile immutable execution receipts.
})
await enest.deadlineTasks.pause('my-task')
await enest.deadlineTasks.resume('my-task')
await enest.deadlineTasks.skip('my-task')
await enest.deadlineTasks.cancel('my-task')
off()
```

- `start/get/pause/resume/skip/cancel` 均返回 `DeadlineTaskSnapshot`；完整结构见自动生成的 SDK。
- 所有权由调用实例确定，不能传另一个 `pluginId`。步骤 `data` 为有界不透明 JSON，业务含义由插件解释。
- 关闭 Tab、休眠不停止计划，也不会为了计时保活 renderer；禁用取消，卸载删除；退出应用及重启恢复为暂停，不在用户睡眠期间补跑大量步骤。
- 内存只保留运行中的计划；空计划没有 timer。单次最近到期唤醒和最长 30 秒检查点负责调度，页面每秒倒计时展示由插件在可见时自己更新。
- 全局最多 64 个计划，每插件最多 4 个，每计划 64 步、最多 2000 条落库回执；单步 1 秒–7 天。不可变回执不是插件可编辑的历史数据库，插件应自行存储统计、备注和删除标记。
- `notification: { title, body }` 是可选原生通知；开始时申请 `notify`，拒绝只移除通知，不阻止计时。投递时再次校验授权；Tab 关闭后的通知需要持久授权。
- 老番茄钟数据由宿主按原插件归属、不解释内容地迁入私有 KV；插件负责解释旧格式和迁移。原文件保留备份，不让卸载后再次导入已删除数据。

基础计划无需 `backend.node`，不会新增 utility process。旧 `enest.focusTimer` 已移除，番茄钟需更新到 1.4.0 或以上。
