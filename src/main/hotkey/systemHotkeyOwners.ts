/**
 * systemHotkeyOwners — 外部程序占用快捷键时的 best-effort 归属识别。
 * 职责：RegisterHotKey / globalShortcut 注册失败时系统不提供占用者信息；
 *      这里维护「常见全局热键程序 → 默认键位」表并检测本机进程，给出可行动的提示。
 * 限制：只能识别进程在跑且键位匹配默认值的情况；识别不出时回退通用提示。
 * 被 shortcutConflicts.ts 调用。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface KnownHotkeyApp {
  /** 显示名 */
  label: string
  /** 各平台候选进程名（小写，不含路径；匹配后缀） */
  processes: Partial<Record<NodeJS.Platform, string[]>>
  /** 各平台默认/常见全局热键（normalizeAccelerator 后比较） */
  defaults: Partial<Record<NodeJS.Platform, string[]>>
  /** 指引用户去哪关闭 */
  hint: string
}

const KNOWN_APPS: KnownHotkeyApp[] = [
  {
    label: 'PowerToys Run',
    processes: { win32: ['powertoys.powerlauncher.exe', 'powerlauncher.exe'] },
    defaults: { win32: ['Alt+Space'] },
    hint: '可在 PowerToys 设置 → PowerToys Run → 「打开快捷方式」中修改或关闭。'
  },
  {
    label: 'uTools',
    processes: { win32: ['utools.exe'], darwin: ['utools'], linux: ['utools'] },
    defaults: { win32: ['Alt+Space'], darwin: ['Alt+Space'], linux: ['Alt+Space'] },
    hint: '可在 uTools 设置 → 基本快捷键中修改或关闭。'
  },
  {
    label: 'Listary',
    processes: { win32: ['listary.exe'] },
    defaults: { win32: ['Ctrl+Ctrl', 'Alt+G'] },
    hint: '可在 Listary 选项 → 快捷键中修改或关闭。'
  },
  {
    label: 'Wox',
    processes: { win32: ['wox.exe'] },
    defaults: { win32: ['Alt+Space'] },
    hint: '可在 Wox 设置 → Hotkey 中修改或关闭。'
  },
  {
    label: 'utools/蜂鸟启动器类（Fluent Search）',
    processes: { win32: ['fluentsearch.exe'] },
    defaults: { win32: ['Ctrl+Alt+Space'] },
    hint: '可在 Fluent Search 设置 → General → Hotkeys 中修改或关闭。'
  },
  {
    label: '输入法语言切换（Windows 系统热键）',
    processes: {},
    defaults: { win32: ['Control+Shift', 'Alt+Shift', 'Control+Space', 'Shift'] },
    hint: '由 Windows 输入法占用：设置 → 时间和语言 → 语言 → 键盘选项中调整。'
  }
]

let processCache: { at: number; names: Set<string> } | undefined
let pending: Promise<Set<string>> | undefined
const PROCESS_CACHE_MS = 5_000

/** 获取当前进程名集合（小写、仅文件名）；失败返回空集合。 */
function currentProcessNames(): Promise<Set<string>> {
  const now = Date.now()
  if (processCache && now - processCache.at < PROCESS_CACHE_MS) return Promise.resolve(processCache.names)
  if (pending) return pending
  // tasklist 输出稳定且无权限问题；只在 win32 需要（其他平台进程表方案不同，暂走通用回退）。
  // 异步执行，绝不阻塞主进程消息循环。
  pending = (async () => {
    const names = new Set<string>()
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 3_000, windowsHide: true })
        for (const line of stdout.split('\n')) {
          const match = line.match(/^"([^"]+)"/)
          if (match) names.add(match[1].toLowerCase())
        }
      }
    } catch { /* 进程枚举失败时静默回退 */ }
    processCache = { at: now, names }
    return names
  })()
  const release = (): void => { pending = undefined }
  pending.then(release, release)
  return pending
}

/** 测试可注入的进程快照。 */
export function setProcessSnapshotForTest(names: string[] | null): void {
  processCache = names ? { at: Date.now(), names: new Set(names.map(name => name.toLowerCase())) } : undefined
  pending = undefined
}

/**
 * 识别 accelerator 可能的外部占用者（异步：可能触发一次 tasklist 扫描）。
 * 返回 undefined 表示无法识别（调用方使用通用提示）。
 */
export async function identifySystemHotkeyOwner(accelerator: string): Promise<{ label: string; hint: string } | undefined> {
  const candidates = KNOWN_APPS.filter(app => {
    const defaults = app.defaults[process.platform]
    if (!defaults?.length) return false
    return defaults.includes(accelerator)
  })
  if (!candidates.length) return undefined
  // 无进程清单的条目（如输入法系统热键）视为始终候选；有进程的必须检测到进程在跑。
  for (const app of candidates) {
    const processes = app.processes[process.platform]
    if (!processes?.length) return { label: app.label, hint: app.hint }
    const running = await currentProcessNames()
    if (processes.some(name => running.has(name))) return { label: app.label, hint: app.hint }
  }
  return undefined
}
