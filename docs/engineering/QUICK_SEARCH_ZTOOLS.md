# Quick 文本检索与 zTools 源码对照

核对日期：2026-10-13。参考仓库为 [ZToolsCenter/ZTools](https://github.com/ZToolsCenter/ZTools)，固定提交 [`6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c`](https://github.com/ZToolsCenter/ZTools/tree/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c)。以下依据实际源码，不以宣传截图或旧文档代替实现。eNest 按行为重新实现，没有移植其 Vue/Pinia 搜索模块。

本次范围是 Quick 的常用网格、名称/拼音/指令检索、文本内容处理指令及异步 provider。**这不是 zTools 插件协议的全量兼容实现**；图片、文件及前台窗口上下文等差异见后文。

## zTools 的真实行为

### 首页与结果分组

- 无关键词且没有粘贴内容时显示「最近使用」「已固定」，随后可显示前台窗口命令。最近使用按最后使用时间排列，不是按使用频率挑选。两个区默认各 9 列、2 行；无历史不会自动补全部已安装插件。
- 「最佳搜索结果」包含主动检索的应用、插件名称、字符串指令与别名。
- 「最佳匹配」包含当前内容命中的 `regex`、`img`、`files` 指令。
- 「匹配推荐」包含接受当前文本的 `over` 指令，例如翻译、网络搜索。它不是低分名称命中的兜底区域。
- 匹配结果按功能使用次数排序；推荐还支持一套独立的置顶顺序。
- `mainPush` 的动态结果按插件功能单独分组，不混入普通名称评分。

源码：[默认行数](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/renderer/src/stores/windowStore.ts#L103-L110)、[分组界面](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/renderer/src/components/search/AggregateView.vue#L3-L99)、[分组计算](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/renderer/src/composables/useSearchResults.ts#L114-L255)。

### 名称索引与排序

每个 `features[].cmds` 字符串独立生成搜索项，保留插件和 feature 身份；结果按功能去重，展示匹配最好的命令名称。另有插件名称入口。别名同样展开、生成拼音字段。说明文案用于显示，不是这一索引的搜索字段。

zTools 使用 Fuse，字段权重为名称 2、全拼 1.5、拼音首字母 1、英文缩写 1.5、别名 1.5；`threshold: 0`、`ignoreLocation: true`。它不是任意字符子序列匹配。名称查询超过 32 个字符时跳过 Fuse，仍执行文本内容匹配。

Fuse 候选再经自定义评分：名称完全匹配 10000；前缀加 5000；连续包含加 2000，并按命中位置加最多 500；再加命中长度占比和首次位置分；非完全匹配的系统应用加 300。同一搜索词上次选择的候选被移到首位。

源码：[索引与指令展开](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/renderer/src/stores/commandDataStore.ts#L990-L1138)、[检索与搜索偏好](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/renderer/src/stores/commandDataStore.ts#L1357-L1498)、[精排公式](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/renderer/src/stores/commandUtils.ts#L64-L114)。

### 内容输入与键盘

空输入框粘贴文字会形成独立内容上下文，此后输入的关键词用于筛选处理器，启动时仍把原文作为 payload。已有输入或选区时则正常插入/替换。图片、文件也是独立上下文；图片/文件存在时不显示无关的名称搜索和 over 推荐。

搜索页默认 Tab/Shift+Tab 逐项循环，左右逐项，上下逐行并夹紧较短行的列号，Enter 执行选中项。IME 组合输入或存在文字选区时保留编辑行为。插件态宿主输入框收到 Tab，会向当前插件 WebContents 转发按下/抬起事件和修饰键，而不是在宿主控件间跳焦点。zTools 还允许把 Tab 配置为执行指定命令。

源码：[粘贴](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/renderer/src/components/search/SearchBox.vue#L719-L784)、[导航](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/renderer/src/composables/useNavigation.ts#L33-L181)、[插件 Tab](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/renderer/src/App.vue#L267-L290)、[启动载荷](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/renderer/src/components/search/SearchResults.vue#L633-L709)。

## eNest 的实现契约

### 声明式文本指令

旧字符串指令兼容，新增两类对象指令：

```json
{
  "features": [
    {
      "code": "translate",
      "explain": "翻译文本",
      "cmds": [
        "翻译",
        "translate",
        { "type": "over", "label": "翻译这段文字", "minLength": 1, "maxLength": 10000, "exclude": "/^https?:/i" }
      ]
    },
    {
      "code": "color",
      "cmds": [
        "颜色",
        { "type": "regex", "label": "识别颜色", "match": "/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i", "minLength": 4 }
      ]
    }
  ]
}
```

- `regex` 要求非空 `label` 和 `match`；兼容 `regex` 字段，二者存在时 `match` 优先。`minLength` 缺省 1。
- `over` 要求非空 `label`，`minLength/maxLength` 缺省 1/10000，边界包含；`exclude` 命中则不推荐。
- 正则必须写为 `/source/flags`，字面量最多 2048 个 UTF-16 单元；支持 JavaScript flags `dgimsuvy`，拒绝重复和无效组合。裸正则源码不作为另一种隐式格式。
- 长度字段必须是非负安全整数，实际 `maxLength` 不得小于 `minLength`；feature code 不能重复；未知命令类型和拼错的对象字段被拒绝。
- 安装时只解析并编译正则语法，不对任何文本执行正则。语法合法不代表匹配成本可控，执行必须在隔离 Worker 中。
- `PluginInstaller` 完整校验与轻量 `isManifest` 共用 `src/shared/pluginCommands.ts`；插件仓库 schema 接受相同的三种指令形状。重复 feature code、正则编译错误和跨字段长度关系由安装器补充检查，标准 JSON Schema 本身不覆盖这些语义。

zTools 基准中，普通输入匹配会丢弃正则 flags，粘贴文字的 over 分支没有应用 exclude；eNest 不复现这两个路径差异，统一保留 flags 并执行排除规则。重复执行前重置正则 `lastIndex`。

插件仓库的三个示例保留原有字符串指令，并在同一 `main` feature 中补充内容入口：翻译接受 1–10000 字的 over，待办接受 1–500 字的 over，计算器用正则识别 3–4096 字、包含数字和运算符的基础算式。计算器推荐仅允许数字、空白、括号和 `+ - * / % ^ .`，完整语法与运算结果仍由插件解析器检查；科学函数仍可从名称入口打开后输入。

这些声明复用现有进入逻辑：待办只预填待办输入框，不保存任务；计算器计算预览，不写入历史；翻译默认只预填，用户启用自动翻译时会按该设置请求翻译服务。新增声明在重新安装更新后的插件包，或开发插件刷新并重新加载 manifest 后生效；修改仓库里的 `plugin.json` 不会更新已经安装的旧包。本次不构建或发布插件包。

### 检索和分组

名称、字符串 cmds 和用户别名预计算规范化名称、全拼、首字母及英文单词缩写，元数据或别名版本变化时重建；大小写、全角和多余空白沿用 eNest 的 NFKC 规则。说明文案不再作为名称命中的兜底。查询超过 32 个规范化字符后只走内容/动态搜索，不扫描名称索引。

eNest 使用自己的连续匹配评分，不引入 Fuse，也不声称数值排序与 zTools 完全相同。核心顺序为精确名称/指令优先于前缀、前缀优先于包含，再考虑拼音及缩写；同词偏好只作用于当前仍命中的主动检索候选。拼音和英文缩写作为显式预计算字段，不恢复任意子序列搜索。

返回项携带 `group`：`best`、`match`、`recommendation`、`provider`。同一个插件功能跨组只展示一次，优先级为主动检索、regex、over，避免同一功能同时占据多个格子。这是 eNest 的去重约定，不是对 zTools 所有组合的逐项复制。

首页按用户要求采用单个「常用」网格，默认两行；保留 eNest 的最近使用衰减/频次及未使用入口补位，不照搬 zTools「最近使用 + 已固定」两个独立区。内置操作不占常用网格。

标准宽度 720px，输入条在常用、搜索、插件三种模式下统一为 64px；两行常用区 184px，默认总高 248px。图标 32px、名称最多两行，移除页脚键盘说明和分组数量。输入框右侧始终显示 eNest 原应用图标，点击进入主窗口插件市场；分类与迁移使用同尺寸的小按钮，切换模式不改变输入框宽度。

### 异步与资源边界

- 声明式文本匹配在隔离 Worker 中运行，Worker 启动上限 3 秒，启动后单次匹配预算 180ms；超时/取消终止该 Worker。正则缓存最多 256 条，空闲 5 秒释放 Worker，堆限制 32 MiB。
- 名称/常用结果先返回，不等待内容正则、图标或 provider；随后并行补齐内容推荐及图标、运行时 provider。按稳定 id 保留当前选中项，查询版本与取消信号防止旧请求覆盖新词结果。应用图标只提取显示额度内的条目（常用默认 16 项）。
- 应用图标保留原始色彩：macOS 优先直接解包应用 ICNS 中的 PNG，旧格式走 NSWorkspace；Windows 读取快捷方式自定义图标或系统目标图标；Linux 查询 XDG 主题的应用尺寸目录。96px 图源适配高密度屏幕；最多 6 路提取、256 条 LRU，成功缓存 15 分钟，失败 15 秒后重试，不把 macOS 通用文件图标当成功。扫描快照中的已有图标随应用索引刷新更新。
- eNest 运行时 provider 通过现有注册契约工作，不等同于 zTools 的声明式 `mainPush`。不因检索自动启动所有插件；manifest `contributes.quickProviders` 仍不代表一个会执行的 provider。
- 剪贴板历史命中仍是 eNest 的历史记录入口，不等同于把当前剪贴板内容交给 img/files/over 处理器。

## 明确未对齐的范围

1. **文件读取与前台窗口指令**：粘贴图片与文件的上下文链路已实现（见下文「已对齐：粘贴内容上下文」）；`window` 前台窗口指令仍未引入，Quick 不读取前台应用状态。文件交付为宿主签发的只读 `localFiles` 句柄，不提供任意路径 API，也不做文件类型图标提取。
2. **文本与搜索词的完全分离卡片**：粘贴的纯文本仍进入 Quick 查询（zTools 把 pastedText 与 searchQuery 分为两个上下文并以卡片展示）。eNest 的文本语义等价达成：打开任意插件时当前输入文本恒随 `onEnter.payload` 交付，regex/over 命中同样携带原文；差异只在 UI 上不存在独立文本卡片与二次筛选。图片/文件则是独立上下文，不写入查询字符串。
3. **首页固定区与推荐置顶**：常用两行遵循 eNest 的需求；没有照搬独立固定区、推荐固定顺序及拖动排序。
4. **精确排序等价**：没有使用 Fuse 的原始分数；eNest 自己计算位置、长度占比并给予非精确系统应用 300 分奖励，细分权重仍不逐数值复刻。连续匹配、拼音、分组和查询偏好属于行为对齐，非结果逐位相等保证。
   内容推荐频次使用 eNest 有界最近使用记录；未在该记录中的条目按零次处理，不等同于 zTools 的独立完整使用统计库。
5. **完整插件协议**：动态 provider、插件进入事件和共享输入框使用 eNest API；不提供 `window.ztools` 兼容层，不能直接安装所有 zTools 插件。
6. **平台验收**：源码契约跨平台共用；本机的真实 Electron 图形验证只覆盖 macOS。Windows/Linux 的窗口动画、输入法和原生拖动仍需对应系统实测。

## 已对齐：粘贴内容上下文（2026-10-26）

对标 zTools 的 img/files 独立内容上下文（[SearchBox.vue handlePaste / SearchResults.vue 启动载荷](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/renderer/src/components/search/SearchBox.vue#L719-L784)）与 uTools 的 `cmds {type:'img'|'files'}` + `onPluginEnter` 语义，成套补齐了链路：

- **请求类型**：`QuickContentMatch.type` 扩为 `text/regex/over/img/files`；`PluginFeatureCommand` 新增 img（`extensions`）与 files（`extensions/minCount/maxCount/allowDirectory`）声明，schema、安装器与 `enest-validate` 同形校验。
- **输入预览/移除**：默认 Quick 输入框左侧渲染有界缩略图（≤4 可见 + 计数，hover 删除钮、空输入 Backspace 移除末项、Esc 先清上下文）；图片经 `nativeImage` 缩到 128px PNG（≤64KB data URL）进入快照，主题 iframe 经 `snapshot.input` 只见缩略图，原始字节与文件路径始终留在主进程 `quickInputContext`（≤8 图 / 单张 12MiB / 合计 32MiB / ≤20 文件）。
- **剪贴板读取**：paste 事件统一走 `quick:input-context { operation: 'read-clipboard' }` 由主进程读取（`clipboard.read()` 位图 / `nativeClipboard.readFiles` 文件），渲染层不提交字节或路径；剪贴板滞后一拍时 60ms 有界重试。主题表面的 `paste` 动作要求一次性原生手势（⌘V/⌘X 确认手势但不拦截按键）。img/files 目录行只在对应上下文存在时进入「最佳匹配」；上下文存在时文本 over 推荐只在没有名称命中时出现（zTools：图片存在时不显示无关 over）。
- **启动载荷**：宿主按不透明 id 组装 `QuickEnterInput { text?, images?[], files?[] }` 随 `enter.input` 交付（`PluginEnterPayload.type` 同步扩枚举）。文件按启动时刻重新 realpath 校验后经 `grantLocalFile` 签发只读句柄；成功启动即视为消费，上下文清空，挂载期间可经 `enest.quickInput.readContext()` 按 runtime 代次重取。Quick 隐藏清空全部上下文。
- **文本随任意打开交付**：`handleOpen` 不再丢弃 `req.query`——插件打开时若无内容匹配载荷/provider 载荷，输入文本（有界 4096）作为 string `payload` 交付，旧插件的 `typeof payload === 'string'` 分支即刻可用（翻译、Anything 等无需改动）。
- **插件示例**：`plugins/image-tools` 1.3.0 声明 `{type:'img', label:'压缩这张图片'}` 并在 `onEnter` 导入 `input.images`；文档见 `docs/site/plugin/manifest.md#触发词与内容指令` 与 `dual-mode-tools.md#输入上下文文本--图片--文件`。

与 zTools 的既有差异保留：eNest 不做文件类型图标提取、无独立文本卡片、files 交付为句柄而非裸路径授权；用户决策（2026-10-26）为 Quick 粘贴上下文按静默授权语义处理（不弹宿主确认），实际可读范围仍由只读句柄收敛。

## 验证入口

```bash
node --test src/shared/pluginCommands.test.mjs
node --test src/main/launcher/quickSearch.test.mjs
node --test src/main/plugin/pluginPerformance.test.mjs
npm run typecheck
```

插件仓库另运行：

```bash
node --test scripts/plugin-command-schema.test.mjs
npm run validate
```

校验回归包含旧字符串指令、混合命令、无效字段、重复身份、默认长度边界、非法 flags/语法、2048 上限及安装拒绝；通过替换正则执行方法确认安装校验不会执行可能灾难性回溯的表达式。搜索回归应覆盖精确命中压过前缀、拼音/首字母、组间去重、长输入、raw payload、正则超时和过期 provider。

### 2026-10-13 本机验证结果

- `npm run build` 通过；最后一次网格水平内边距调整后，使用相同 production 配置重建 renderer 通过。
- `tsc --noEmit -p tsconfig.web.json` 通过。完整 `npm run typecheck` 未通过：已有 `src/main/middleware/` 中 kafka/mqtt/rabbitmq/rocketmq/mwService 的类型错误仍存在，本次未覆盖这些并行工作。
- Quick 网格、Host 生命周期、输入框所有权及窗口恢复回归合计 32/32 通过；名称/内容检索、provider 与正则 Worker 的专项回归通过。
- 图标模拟回归 5/5 通过，覆盖 macOS 原图读取、Windows 快捷方式、Linux 主题目录、并发去重、缓存上限与失败重试。独立 Electron 实测 6 个本机应用全部输出 96×96 原图，首次合计 266.42ms、缓存合计 0.19ms；ChatGPT 原图本身为黑白，其余样本均检出原生彩色像素。该数字只测图标提取，不是启动耗时。
- macOS 生产构建原生窗口回归 1/1 通过（约 28.34 秒）：720×248 两行常用、搜索分组、原始内容载荷、三态输入几何一致、64px 接缝、Esc/长按 Esc、连续开关、Quick/主窗复用同一 WebContents、市场图标点击、窗口关闭销毁。截图来自真实原生合成窗口。
- 该 UI 回归使用隔离 profile，并在测试进程内隔离桌面失焦及外部键盘输入干扰；不据此声称已覆盖系统失焦自动隐藏、实际鼠标拖动或 Windows/Linux 图形行为。
- 插件仓库 manifest 校验通过；8 个插件页脚精简保留业务按钮、状态节点、连接/保存/只读/错误提示及必要安全事实。插件源码未打包或发布，开发插件需刷新，已安装包需更新后生效。

原生窗口证据：`/var/folders/h8/10lgg_wn1xg5h9yvsjlgcbrr0000gn/T/enest-quick-smoke-artifacts-tGePwo/quick-window-evidence.json`；图标证据：`/var/folders/h8/10lgg_wn1xg5h9yvsjlgcbrr0000gn/T/enest-app-icons-native-JZ9e7Q/results.json`。构建、类型检查和回归日志分别保存在 `/tmp/enest-quick-compact-{build,typecheck,regression,native,plugins}.log`。
