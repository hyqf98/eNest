/**
 * com.enest.ssh — 静态命令词典 + 危险规则 + 默认片段
 * 对齐 Spec SSH-E2 / E4 / D5
 */
;(function (global) {
  const CATEGORY_LABEL = {
    system: '系统',
    network: '网络',
    service: '服务',
    text: '文本',
    container: '容器',
    vcs: '版本',
    data: '数据',
    archive: '压缩',
  }

  /** P0 静态词典 */
  const DICT = [
    { cmd: 'ls', desc: '列出目录内容', category: 'system', flags: [
      { name: '-l', desc: '长格式' }, { name: '-a', desc: '显示隐藏文件' }, { name: '-h', desc: '人类可读大小' },
    ] },
    { cmd: 'cd', desc: '切换目录', category: 'system', flags: [] },
    { cmd: 'pwd', desc: '打印当前目录', category: 'system', flags: [] },
    { cmd: 'mkdir', desc: '创建目录', category: 'system', flags: [
      { name: '-p', desc: '递归创建' },
    ] },
    { cmd: 'rm', desc: '删除文件/目录', category: 'system', flags: [
      { name: '-r', desc: '递归' }, { name: '-f', desc: '强制' }, { name: '-rf', desc: '递归强制（危险）' },
    ] },
    { cmd: 'cp', desc: '复制', category: 'system', flags: [{ name: '-r', desc: '递归' }] },
    { cmd: 'mv', desc: '移动/重命名', category: 'system', flags: [] },
    { cmd: 'chmod', desc: '修改权限', category: 'system', flags: [{ name: '-R', desc: '递归' }] },
    { cmd: 'chown', desc: '修改属主', category: 'system', flags: [{ name: '-R', desc: '递归' }] },
    { cmd: 'ps', desc: '进程列表', category: 'system', flags: [{ name: 'aux', desc: 'BSD 风格全量' }, { name: '-ef', desc: 'System V 全量' }] },
    { cmd: 'top', desc: '实时进程', category: 'system', flags: [] },
    { cmd: 'free', desc: '内存使用', category: 'system', flags: [{ name: '-h', desc: '人类可读' }] },
    { cmd: 'df', desc: '磁盘使用', category: 'system', flags: [{ name: '-h', desc: '人类可读' }] },
    { cmd: 'du', desc: '目录占用', category: 'system', flags: [{ name: '-sh', desc: '汇总' }] },
    { cmd: 'uname', desc: '系统信息', category: 'system', flags: [{ name: '-a', desc: '全部' }] },
    { cmd: 'uptime', desc: '负载与运行时长', category: 'system', flags: [] },
    { cmd: 'kill', desc: '结束进程', category: 'system', flags: [{ name: '-9', desc: '强制杀死' }] },
    { cmd: 'nice', desc: '调整优先级启动', category: 'system', flags: [] },

    { cmd: 'ss', desc: '套接字统计', category: 'network', flags: [{ name: '-lntp', desc: '监听 TCP 进程' }] },
    { cmd: 'netstat', desc: '网络连接', category: 'network', flags: [{ name: '-lntp', desc: '监听 TCP' }] },
    { cmd: 'ping', desc: 'ICMP 探测', category: 'network', flags: [{ name: '-c', desc: '次数' }] },
    { cmd: 'curl', desc: 'HTTP 客户端', category: 'network', flags: [
      { name: '-I', desc: '仅头' }, { name: '-s', desc: '静默' }, { name: '-X', desc: '方法' },
    ] },
    { cmd: 'wget', desc: '下载文件', category: 'network', flags: [{ name: '-O', desc: '输出路径' }] },
    { cmd: 'iptables', desc: '防火墙规则', category: 'network', flags: [{ name: '-L', desc: '列出' }] },
    { cmd: 'scp', desc: '远程拷贝', category: 'network', flags: [{ name: '-r', desc: '递归' }, { name: '-P', desc: '端口' }] },
    { cmd: 'rsync', desc: '增量同步', category: 'network', flags: [{ name: '-avz', desc: '归档压缩详细' }] },

    { cmd: 'systemctl', desc: 'systemd 服务', category: 'service', flags: [
      { name: 'status', desc: '状态' }, { name: 'restart', desc: '重启' }, { name: 'stop', desc: '停止' }, { name: 'start', desc: '启动' },
    ] },
    { cmd: 'journalctl', desc: '服务日志', category: 'service', flags: [
      { name: '-u', desc: '按单元' }, { name: '-f', desc: '跟随' }, { name: '-n', desc: '行数' },
    ] },
    { cmd: 'service', desc: 'SysV 服务', category: 'service', flags: [] },

    { cmd: 'grep', desc: '文本搜索', category: 'text', flags: [
      { name: '-r', desc: '递归' }, { name: '-n', desc: '行号' }, { name: '-i', desc: '忽略大小写' }, { name: '-E', desc: '扩展正则' },
    ] },
    { cmd: 'sed', desc: '流编辑器', category: 'text', flags: [{ name: '-n', desc: '静默' }, { name: '-i', desc: '就地' }] },
    { cmd: 'awk', desc: '列处理', category: 'text', flags: [] },
    { cmd: 'tail', desc: '文件尾部', category: 'text', flags: [{ name: '-f', desc: '跟随' }, { name: '-n', desc: '行数' }] },
    { cmd: 'head', desc: '文件头部', category: 'text', flags: [{ name: '-n', desc: '行数' }] },
    { cmd: 'less', desc: '分页查看', category: 'text', flags: [] },
    { cmd: 'cat', desc: '拼接输出', category: 'text', flags: [] },
    { cmd: 'echo', desc: '输出字符串', category: 'text', flags: [] },
    { cmd: 'xargs', desc: '参数拼接执行', category: 'text', flags: [{ name: '-n', desc: '每次参数个数' }] },
    { cmd: 'find', desc: '查找文件', category: 'text', flags: [
      { name: '-name', desc: '文件名' }, { name: '-type', desc: '类型' }, { name: '-mtime', desc: '修改天数' },
    ] },

    { cmd: 'docker', desc: '容器引擎', category: 'container', flags: [
      { name: 'ps', desc: '容器列表' }, { name: 'logs', desc: '日志' }, { name: 'exec', desc: '进入容器' },
    ] },
    { cmd: 'docker-compose', desc: '编排', category: 'container', flags: [
      { name: 'up', desc: '启动' }, { name: 'down', desc: '停止删除' }, { name: 'ps', desc: '状态' },
    ] },
    { cmd: 'kubectl', desc: 'Kubernetes', category: 'container', flags: [
      { name: 'get', desc: '获取资源' }, { name: 'describe', desc: '详情' }, { name: 'logs', desc: 'Pod 日志' },
    ] },
    { cmd: 'helm', desc: 'K8s 包管理', category: 'container', flags: [{ name: 'list', desc: '发布列表' }] },

    { cmd: 'git', desc: '版本控制', category: 'vcs', flags: [
      { name: 'status', desc: '状态' }, { name: 'pull', desc: '拉取' }, { name: 'log', desc: '日志' },
    ] },

    { cmd: 'redis-cli', desc: 'Redis 客户端', category: 'data', flags: [] },
    { cmd: 'mysql', desc: 'MySQL 客户端', category: 'data', flags: [{ name: '-u', desc: '用户' }, { name: '-p', desc: '密码' }] },
    { cmd: 'nginx', desc: 'Nginx', category: 'data', flags: [{ name: '-t', desc: '配置检查' }, { name: '-s', desc: '信号 reload/stop' }] },

    { cmd: 'tar', desc: '归档', category: 'archive', flags: [
      { name: '-czf', desc: 'gzip 打包' }, { name: '-xzf', desc: 'gzip 解包' }, { name: '-tf', desc: '查看列表' },
    ] },
    { cmd: 'gzip', desc: 'gzip 压缩', category: 'archive', flags: [] },
    { cmd: 'gunzip', desc: 'gzip 解压', category: 'archive', flags: [] },
    { cmd: 'zip', desc: 'zip 打包', category: 'archive', flags: [{ name: '-r', desc: '递归' }] },
    { cmd: 'unzip', desc: 'zip 解压', category: 'archive', flags: [] },
  ]

  /**
   * 危险规则（SSH-E4）。
   * match(cmd, profileEnv) → { level: 'danger'|'warn', reason: string } | null
   */
  const DANGER_RULES = [
    {
      id: 'rm-rf-root',
      re: /\brm\s+(-[a-zA-Z]*\s+)*(-\w*r\w*f|-\w*f\w*r)\b[^|;&]*\s(\/|\/\*|\.\s*$)/i,
      level: 'danger',
      reason: 'rm -rf 指向根目录或当前目录，可能导致数据全毁',
    },
    {
      id: 'rm-rf',
      re: /\brm\s+(-[a-zA-Z]*\s+)*(-\w*r\w*f|-\w*f\w*r)\b/i,
      level: 'danger',
      reason: 'rm -rf 递归强制删除',
    },
    {
      id: 'mkfs',
      re: /\bmkfs(\.\w+)?\b/i,
      level: 'danger',
      reason: 'mkfs 将格式化文件系统',
    },
    {
      id: 'dd-dev',
      re: /\bdd\b[^|;&]*\bof=\/dev\//i,
      level: 'danger',
      reason: 'dd 写入块设备',
    },
    {
      id: 'redirect-dev-sd',
      re: />\s*\/dev\/sd[a-z]/i,
      level: 'danger',
      reason: '重定向写入磁盘设备节点',
    },
    {
      id: 'kill-init',
      re: /\bkill\s+(-9\s+)?1\b/i,
      level: 'danger',
      reason: '对 PID 1 发送信号会导致主机重启/崩溃',
    },
    {
      id: 'shutdown',
      re: /\b(shutdown|reboot|poweroff|halt)\b/i,
      level: 'danger',
      reason: '关机/重启命令',
    },
    {
      id: 'drop-db',
      re: /\bDROP\s+(DATABASE|SCHEMA|TABLE)\b/i,
      level: 'danger',
      reason: 'DROP DATABASE/SCHEMA/TABLE',
    },
    {
      id: 'chmod-777-root',
      re: /\bchmod\s+(-R\s+)?777\s+(\/|\s*$)/i,
      level: 'danger',
      reason: 'chmod -R 777 / 过度放开权限',
    },
    {
      id: 'systemctl-stop-prod',
      re: /\bsystemctl\s+stop\b/i,
      level: 'warn',
      reason: 'systemctl stop 会停止服务',
      env: 'prod',
    },
  ]

  function matchDanger(command, profileEnv) {
    const cmd = String(command || '')
    if (!cmd.trim()) return null
    for (const rule of DANGER_RULES) {
      if (rule.env && rule.env !== 'prod' && profileEnv && profileEnv !== 'prod') {
        // env-scoped rules only on prod (or when env unknown on rule)
      }
      if (rule.env && profileEnv && profileEnv !== rule.env) continue
      if (rule.re.test(cmd)) {
        return { id: rule.id, level: rule.level, reason: rule.reason }
      }
    }
    return null
  }

  /** 常用运维片段（首次启动种子） */
  const DEFAULT_SNIPPETS = [
    { id: 'snip-disk', title: '磁盘占用', command: 'df -h', tags: ['运维'], sort: 0, pinned: true },
    { id: 'snip-mem', title: '内存概览', command: 'free -h', tags: ['运维'], sort: 1, pinned: true },
    { id: 'snip-listen', title: '监听端口', command: 'ss -lntp', tags: ['网络'], sort: 2, pinned: false },
    { id: 'snip-docker-ps', title: 'Docker 容器', command: 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"', tags: ['容器'], sort: 3, pinned: false },
    { id: 'snip-journal', title: '服务日志（跟随）', command: 'journalctl -u <service> -f -n 200', tags: ['服务'], sort: 4, pinned: false },
    { id: 'snip-top-mem', title: '内存 Top 进程', command: 'ps aux --sort=-%mem | head -n 11', tags: ['运维'], sort: 5, pinned: false },
  ]

  /**
   * 本地合并补全（SSH-E1 本地源）
   * sources: { prefix, history[], snippets[], userDict[] }
   */
  function localSuggest(prefix, sources) {
    const p = String(prefix || '').trim()
    const lower = p.toLowerCase()
    const items = []
    const seen = new Set()
    const push = (it) => {
      const key = it.kind + '|' + it.text
      if (seen.has(key)) return
      seen.add(key)
      items.push(it)
    }

    const lastToken = p.split(/\s+/).filter(Boolean).pop() || ''
    const isPathLike = /^[~./]/.test(lastToken) || p.includes('/')
    const isFlag = lastToken.startsWith('-')
    const firstWord = p.trim().split(/\s+/)[0] || ''
    const afterFirst = p.trim().split(/\s+/).length > 1

    // 静态词典
    for (const entry of DICT) {
      if (!afterFirst && !isFlag) {
        if (!lower || entry.cmd.toLowerCase().startsWith(lower)) {
          push({
            kind: 'cmd',
            text: entry.cmd,
            detail: entry.desc + ' · ' + (CATEGORY_LABEL[entry.category] || entry.category),
            sort: 0,
          })
        }
      }
      if (entry.cmd === firstWord && isFlag) {
        for (const f of entry.flags || []) {
          if (!lastToken || f.name.toLowerCase().startsWith(lastToken.toLowerCase())) {
            push({ kind: 'flag', text: entry.cmd + ' ' + f.name, detail: f.desc, sort: 1, replace: 'last' })
          }
        }
      }
    }

    // 片段
    for (const s of sources.snippets || []) {
      const hay = ((s.title || '') + ' ' + (s.command || '')).toLowerCase()
      if (!lower || hay.includes(lower) || (s.command || '').toLowerCase().startsWith(lower)) {
        push({
          kind: 'snippet',
          text: s.command,
          detail: s.title || '常用',
          sort: 2,
        })
      }
    }

    // 历史：profile 优先
    const hist = sources.history || []
    const profileHits = []
    const globalHits = []
    for (const h of hist) {
      const c = h.command || ''
      if (!c) continue
      if (!lower || c.toLowerCase().startsWith(lower) || c.toLowerCase().includes(lower)) {
        if (h.profileId && sources.profileId && h.profileId === sources.profileId) profileHits.push(h)
        else globalHits.push(h)
      }
    }
    profileHits.sort((a, b) => (b.ts || 0) - (a.ts || 0))
    globalHits.sort((a, b) => (b.ts || 0) - (a.ts || 0))
    for (const h of profileHits.slice(0, 8)) {
      push({ kind: 'history', text: h.command, detail: '本机历史', sort: 3, ts: h.ts })
    }
    for (const h of globalHits.slice(0, 6)) {
      push({ kind: 'history', text: h.command, detail: '全局历史', sort: 4, ts: h.ts })
    }

    // 用户词典（P1，storage 可选）
    for (const u of sources.userDict || []) {
      const text = u.cmd || u.alias || u.text
      if (!text) continue
      if (!lower || text.toLowerCase().includes(lower)) {
        push({ kind: 'cmd', text, detail: u.desc || '用户词典', sort: 5 })
      }
    }

    // 路径占位提示（真实路径由宿主 completion.suggest 提供）
    if (isPathLike && !items.length) {
      push({ kind: 'path', text: p, detail: '远程路径补全中…', sort: 6 })
    }

    items.sort((a, b) => (a.sort - b.sort))
    return items
  }

  global.SshDict = {
    DICT,
    DANGER_RULES,
    DEFAULT_SNIPPETS,
    CATEGORY_LABEL,
    matchDanger,
    localSuggest,
  }
})(window)
