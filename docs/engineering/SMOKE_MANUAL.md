# 最终批次人工冒烟清单

自动化覆盖见 `scripts/smoke-final.mjs`（结果矩阵在批次最终报告）。以下项目无法经 CDP 安全注入或需要真实系统交互，需人工在 `npm run dev` 下逐项验证。

## 1. crash 自愈（首崩自动重启）

自动化无法对插件 WebContentsView 的渲染进程安全注入 crash（CDP `Page.crash` 只对 attach 的页面生效，插件 view 独立进程且不共享 CDP session）。

步骤：

1. 打开 Hello 插件（主窗 Tab）
2. 对插件页面打开 DevTools（设置 → 开发者 → 已打开插件的 DevTools）
3. 在 DevTools Console 执行 `process.crash()`（渲染层 sandbox 下可用 `window.location = 'enest://crash'` 不可行时，改用 DevTools ⋯ → More tools → 「Crash renderer」不存在则跳过，直接用插件 preload 的 node 集成在 sandbox=false 下 `process.crash()`）
4. 预期：主进程日志出现 `[lifecycle] com.example.hello: crashed ... auto restart`，Tab 自动恢复内容（不显示崩溃面板）
5. 再崩一次（连续第二次）：Tab 保留但显示崩溃态，点击重试重新打开

## 2. Alt+Space 全局热键呼出 Quick（真实系统热键）

自动化无法注册/触达系统级全局快捷键。

1. 任意前台应用下按 `Alt+Space`（或 `Ctrl+Space`）→ Quick 小窗出现在鼠标所在屏
2. 输入 `hello` → 回车 → 插件内嵌 Quick（顶部 64px 输入条 + 插件内容）
3. `Esc` 回列表；再 `Esc` 隐藏
4. `⌘Enter`（插件态）→ 固定到主窗（view 迁移、Tab 出现、无白屏闪烁）

## 3. orb 圆轨 hover 交互（真实鼠标 hover 展开）

自动化只验证了 rail DOM 渲染与数据接线；hover 展开/收起动画与真实鼠标事件路径需人工：

1. 设置 → 外观 → Tab 样式切「圆轨（orb）」
2. 鼠标移到窗口左缘窄条 → 圆轨展开；移出 → 延迟收起
3. 确认 Tab 圆点之后有分隔线 + Hello 入口圆点（H 字符、蓝底）
4. 点击 Hello 入口 → 插件以 code=hello 打开（主窗 Tab）
5. 验证后切回原 Tab 样式

## 4. 设置 slider/color 控件真实拖拽

自动化只验证了控件存在与值持久化；真实拖拽交互：

1. 设置 → Hello 插件分组：拖动「展示字号」slider、选「强调色」color
2. 值立即保存（无需确认按钮）
3. 重启 dev → 值回显

## 5. DevConsole 调用跟踪面板 UI

自动化只验证了数据源 IPC；面板 UI 需人工：

1. 设置 → 开发者 → 打开任意插件并操作（如 Hello 打招呼）
2. 「调用跟踪」面板点「刷新」→ 表格出现时间/插件/方法/耗时行
3. 开「轮询」→ 每秒自动刷新；关 → 停止
4. 失败调用（如无权限 API）行显示红色错误信息

## 6. ⌘Enter 固定的「不重载」视觉确认

自动化验证了 Tab 出现与迁移语义（IPC 层）；「不重载」需人工确认插件内部状态（如插件内计数器/输入内容）在固定后保留：

1. Quick 内嵌打开 Hello（先在插件里做个可见状态，如点几次按钮）
2. `⌘Enter` 固定到主窗
3. 预期：插件状态原样（无白屏闪烁/重新加载）
