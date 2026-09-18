/**
 * ssh commandDict — 静态命令词典 + 危险规则（Spec SSH-E）
 * 职责：为 ssh.completion.suggest 提供 cmd/flag 候选与危险命令检测。
 * 被 sshSessionManager 引用；无外部依赖。
 */

export interface DictFlag {
  name: string
  desc: string
}

export interface DictCommand {
  cmd: string
  desc: string
  category: string
  flags: DictFlag[]
}

export const SSH_COMMAND_DICT: DictCommand[] = [
  { cmd: 'ls', desc: '列出目录内容', category: '系统', flags: [{ name: '-l', desc: '长格式' }, { name: '-a', desc: '显示隐藏文件' }, { name: '-h', desc: '人类可读大小' }, { name: '-R', desc: '递归' }] },
  { cmd: 'cd', desc: '切换目录', category: '系统', flags: [] },
  { cmd: 'pwd', desc: '打印当前目录', category: '系统', flags: [] },
  { cmd: 'mkdir', desc: '创建目录', category: '系统', flags: [{ name: '-p', desc: '递归创建' }] },
  { cmd: 'rm', desc: '删除文件/目录', category: '系统', flags: [{ name: '-rf', desc: '强制递归删除（危险）' }, { name: '-i', desc: '交互确认' }] },
  { cmd: 'cp', desc: '复制文件', category: '系统', flags: [{ name: '-r', desc: '递归' }, { name: '-a', desc: '归档模式' }] },
  { cmd: 'mv', desc: '移动/重命名', category: '系统', flags: [] },
  { cmd: 'chmod', desc: '修改权限', category: '系统', flags: [{ name: '-R', desc: '递归' }] },
  { cmd: 'chown', desc: '修改属主', category: '系统', flags: [{ name: '-R', desc: '递归' }] },
  { cmd: 'ps', desc: '查看进程', category: '系统', flags: [{ name: '-ef', desc: '全量进程' }, { name: 'aux', desc: 'BSD 风格' }] },
  { cmd: 'top', desc: '进程监控', category: '系统', flags: [{ name: '-b', desc: '批处理模式' }] },
  { cmd: 'free', desc: '内存使用', category: '系统', flags: [{ name: '-h', desc: '人类可读' }, { name: '-m', desc: 'MB 单位' }] },
  { cmd: 'df', desc: '磁盘使用', category: '系统', flags: [{ name: '-h', desc: '人类可读' }] },
  { cmd: 'du', desc: '目录占用', category: '系统', flags: [{ name: '-sh', desc: '汇总人类可读' }] },
  { cmd: 'uname', desc: '系统信息', category: '系统', flags: [{ name: '-a', desc: '全部信息' }] },
  { cmd: 'uptime', desc: '运行时长与负载', category: '系统', flags: [] },
  { cmd: 'kill', desc: '结束进程', category: '系统', flags: [{ name: '-9', desc: 'SIGKILL（危险）' }] },
  { cmd: 'nice', desc: '调整优先级', category: '系统', flags: [] },
  { cmd: 'ss', desc: '套接字统计', category: '网络', flags: [{ name: '-tulpn', desc: 'TCP/UDP 监听' }] },
  { cmd: 'netstat', desc: '网络连接', category: '网络', flags: [{ name: '-tulpn', desc: '监听端口' }] },
  { cmd: 'ping', desc: 'ICMP 探测', category: '网络', flags: [{ name: '-c', desc: '次数' }] },
  { cmd: 'curl', desc: 'HTTP 请求', category: '网络', flags: [{ name: '-I', desc: '仅头' }, { name: '-v', desc: '详细' }, { name: '-X', desc: '方法' }] },
  { cmd: 'wget', desc: '下载文件', category: '网络', flags: [{ name: '-O', desc: '输出路径' }] },
  { cmd: 'iptables', desc: '防火墙规则', category: '网络', flags: [{ name: '-L', desc: '列出规则' }] },
  { cmd: 'scp', desc: '远程复制', category: '网络', flags: [{ name: '-r', desc: '递归' }, { name: '-P', desc: '端口' }] },
  { cmd: 'rsync', desc: '增量同步', category: '网络', flags: [{ name: '-avz', desc: '归档压缩' }] },
  { cmd: 'systemctl', desc: 'systemd 服务', category: '服务', flags: [{ name: 'status', desc: '查看状态' }, { name: 'restart', desc: '重启' }, { name: 'stop', desc: '停止' }, { name: 'start', desc: '启动' }, { name: 'enable', desc: '开机启动' }] },
  { cmd: 'journalctl', desc: '日志查询', category: '服务', flags: [{ name: '-u', desc: '指定单元' }, { name: '-f', desc: '跟随' }, { name: '-n', desc: '行数' }] },
  { cmd: 'service', desc: 'SysV 服务', category: '服务', flags: [] },
  { cmd: 'grep', desc: '文本搜索', category: '文本', flags: [{ name: '-r', desc: '递归' }, { name: '-n', desc: '显示行号' }, { name: '-i', desc: '忽略大小写' }, { name: '-v', desc: '反向匹配' }] },
  { cmd: 'sed', desc: '流编辑器', category: '文本', flags: [{ name: '-i', desc: '原地修改' }] },
  { cmd: 'awk', desc: '列处理', category: '文本', flags: [] },
  { cmd: 'tail', desc: '查看末尾', category: '文本', flags: [{ name: '-f', desc: '跟随文件' }, { name: '-n', desc: '行数' }] },
  { cmd: 'head', desc: '查看开头', category: '文本', flags: [{ name: '-n', desc: '行数' }] },
  { cmd: 'less', desc: '分页查看', category: '文本', flags: [] },
  { cmd: 'cat', desc: '拼接输出', category: '文本', flags: [] },
  { cmd: 'echo', desc: '输出文本', category: '文本', flags: [] },
  { cmd: 'xargs', desc: '参数传递', category: '文本', flags: [{ name: '-n', desc: '每批参数数' }] },
  { cmd: 'find', desc: '查找文件', category: '文本', flags: [{ name: '-name', desc: '按名匹配' }, { name: '-type', desc: '按类型' }] },
  { cmd: 'docker', desc: '容器管理', category: '容器', flags: [{ name: 'ps', desc: '容器列表' }, { name: 'logs', desc: '查看日志' }, { name: 'exec', desc: '进入容器' }, { name: 'images', desc: '镜像列表' }] },
  { cmd: 'docker-compose', desc: '编排', category: '容器', flags: [{ name: 'up', desc: '启动' }, { name: 'down', desc: '停止移除' }, { name: 'ps', desc: '状态' }] },
  { cmd: 'kubectl', desc: 'K8s 客户端', category: '容器', flags: [{ name: 'get', desc: '获取资源' }, { name: 'describe', desc: '详情' }, { name: 'logs', desc: 'Pod 日志' }] },
  { cmd: 'helm', desc: 'K8s 包管理', category: '容器', flags: [{ name: 'list', desc: 'Release 列表' }, { name: 'status', desc: '状态' }] },
  { cmd: 'git', desc: '版本控制', category: '版本', flags: [{ name: 'status', desc: '状态' }, { name: 'log', desc: '提交历史' }, { name: 'pull', desc: '拉取' }, { name: 'push', desc: '推送' }] },
  { cmd: 'redis-cli', desc: 'Redis 客户端', category: '数据', flags: [{ name: '-h', desc: '主机' }, { name: '-p', desc: '端口' }] },
  { cmd: 'mysql', desc: 'MySQL 客户端', category: '数据', flags: [{ name: '-u', desc: '用户' }, { name: '-p', desc: '密码' }, { name: '-h', desc: '主机' }] },
  { cmd: 'nginx', desc: 'Nginx', category: '数据', flags: [{ name: '-t', desc: '配置检查' }, { name: '-s', desc: '信号 reload/stop' }] },
  { cmd: 'tar', desc: '归档', category: '压缩', flags: [{ name: '-xzvf', desc: '解压 gz' }, { name: '-czvf', desc: '打包 gz' }] },
  { cmd: 'gzip', desc: 'gzip 压缩', category: '压缩', flags: [] },
  { cmd: 'gunzip', desc: 'gzip 解压', category: '压缩', flags: [] },
  { cmd: 'zip', desc: 'zip 压缩', category: '压缩', flags: [{ name: '-r', desc: '递归' }] },
  { cmd: 'unzip', desc: 'zip 解压', category: '压缩', flags: [] }
]

/** systemctl 等动词子命令上下文 */
export const SSH_SUBCOMMANDS: Record<string, string[]> = {
  systemctl: ['status', 'start', 'stop', 'restart', 'reload', 'enable', 'disable', 'list-units', 'is-active', 'is-enabled'],
  docker: ['ps', 'images', 'logs', 'exec', 'run', 'stop', 'rm', 'rmi', 'build', 'pull', 'push', 'inspect', 'stats'],
  kubectl: ['get', 'describe', 'logs', 'apply', 'delete', 'exec', 'port-forward', 'scale', 'rollout'],
  git: ['status', 'log', 'diff', 'pull', 'push', 'fetch', 'checkout', 'branch', 'merge', 'rebase', 'commit', 'stash'],
  journalctl: ['-u', '-f', '-n', '--since', '--until', '--no-pager'],
  'docker-compose': ['up', 'down', 'ps', 'logs', 'build', 'restart', 'pull', 'exec'],
  helm: ['list', 'status', 'install', 'upgrade', 'uninstall', 'repo', 'search'],
  nginx: ['-t', '-s', '-v', '-V']
}

export interface DangerousRule {
  pattern: RegExp
  desc: string
}

/** Spec SSH-E4 危险规则（P0） */
export const SSH_DANGEROUS_RULES: DangerousRule[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-\w*[rf]\w*\s+(\*|\/|\~|\/\*|~\/)/i, desc: 'rm -rf 根目录/家目录' },
  { pattern: /\brm\s+-rf\b/i, desc: 'rm -rf 强制递归删除' },
  { pattern: /\bmkfs\b/i, desc: 'mkfs 格式化文件系统' },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//i, desc: 'dd 写入块设备' },
  { pattern: />\s*\/dev\/sd/i, desc: '重定向写入磁盘设备' },
  { pattern: /\bkill\s+-9\s+1\b/i, desc: 'kill -9 1（init）' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, desc: '关机/重启' },
  { pattern: /\bDROP\s+(DATABASE|SCHEMA|TABLE)\b/i, desc: 'DROP DATABASE/TABLE' },
  { pattern: /\bchmod\s+-R\s+777\s+\//i, desc: 'chmod -R 777 /' },
  { pattern: /\bsystemctl\s+stop\b/i, desc: 'systemctl stop' },
  { pattern: /\btruncate\s+table\b/i, desc: 'TRUNCATE TABLE' }
]

export function detectDangerous(input: string): string | null {
  for (const rule of SSH_DANGEROUS_RULES) {
    if (rule.pattern.test(input)) return rule.desc
  }
  return null
}

/** 命令名前缀 → 词典条目 */
export function lookupDictCmd(prefix: string): DictCommand[] {
  const p = prefix.toLowerCase()
  return SSH_COMMAND_DICT.filter((c) => c.cmd.startsWith(p))
}
