import { Socket, isIP } from 'node:net'
import { domainToASCII } from 'node:url'
interface SocketProxyConfig { type: 'http-connect' | 'socks5'; host: string; port: number; username?: string }

function hostName(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 253 || /[\s\x00-\x1f\x7f/@?#\\]/.test(value)) throw new Error('代理或目标主机名无效')
  const host = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  if (isIP(host)) return host
  const ascii = domainToASCII(host)
  if (!ascii || ascii.length > 253 || !/^[a-z0-9._-]+$/i.test(ascii)) throw new Error('代理或目标主机名无效')
  return ascii
}

function portNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('代理或目标端口必须在 1–65535 之间')
  return value
}

function socksAddress(host: string): Buffer {
  if (isIP(host) === 4) return Buffer.from([1, ...host.split('.').map(Number)])
  if (isIP(host) === 6) {
    // Expand IPv4-mapped addresses before filling an IPv6 :: gap.
    const expanded = host.replace(/\d+\.\d+\.\d+\.\d+$/, part => {
      const bytes = part.split('.').map(Number)
      return ((bytes[0] << 8) | bytes[1]).toString(16) + ':' + ((bytes[2] << 8) | bytes[3]).toString(16)
    })
    const [left, right] = expanded.split('::')
    const a = left ? left.split(':') : [], b = right ? right.split(':') : []
    const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b]
    const bytes = Buffer.alloc(17); bytes[0] = 4
    words.forEach((word, index) => bytes.writeUInt16BE(parseInt(word, 16), 1 + index * 2))
    return bytes
  }
  const bytes = Buffer.from(host, 'ascii')
  return Buffer.concat([Buffer.from([3, bytes.length]), bytes])
}

/** Native HTTP CONNECT / SOCKS5 handshake; no environment or global proxy lookup. */
export function openSocketProxy(
  proxy: SocketProxyConfig,
  target: { host: string; port: number },
  password: string | null,
  options: { signal: AbortSignal; timeoutMs: number; ownSocket: (socket: Socket) => void }
): Promise<Socket> {
  const proxyHost = hostName(proxy.host), proxyPort = portNumber(proxy.port)
  const targetHost = hostName(target.host), targetPort = portNumber(target.port)
  if (targetHost.includes('%')) throw new Error('TCP 代理目标不支持带接口区域的 IPv6 地址')
  if (proxy.type !== 'http-connect' && proxy.type !== 'socks5') throw new Error('不支持的 TCP 代理类型')
  const username = proxy.username || ''
  if (typeof username !== 'string' || typeof password !== 'string' && password !== null) throw new Error('代理认证信息无效')
  const authenticated = username.length > 0
  if (authenticated && password === null) throw new Error('代理密码未设置或已失效，请重新输入')
  if (proxy.type === 'http-connect' && username.includes(':')) throw new Error('HTTP 代理用户名不能包含冒号')
  const user = Buffer.from(username), secret = Buffer.from(password || '')
  if (proxy.type === 'socks5' && authenticated && (user.length > 255 || secret.length < 1 || secret.length > 255)) throw new Error('SOCKS5 用户名与密码须各为 1–255 UTF-8 字节')
  if (user.length > 4096 || secret.length > 16384) throw new Error('代理认证信息过长')
  if (options.signal.aborted) return Promise.reject(new Error('TCP session is closing'))

  return new Promise<Socket>((resolve, reject) => {
    const socket = new Socket()
    let buffer = Buffer.alloc(0), phase: 'http' | 'method' | 'auth' | 'reply' = proxy.type === 'http-connect' ? 'http' : 'method'
    let settled = false
    const timer = setTimeout(() => fail(new Error('TCP 代理连接超时')), Math.max(100, Math.min(120000, options.timeoutMs || 20000)))
    const cleanup = (): void => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
      socket.removeListener('data', data)
      socket.removeListener('error', failed)
      socket.removeListener('close', closed)
      socket.removeListener('end', closed)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true; cleanup(); socket.destroy(); reject(error)
    }
    const abort = (): void => fail(new Error('TCP session is closing'))
    const failed = (error: NodeJS.ErrnoException): void => fail(new Error('TCP 代理连接失败' + (error.code ? ` (${error.code})` : '')))
    const closed = (): void => fail(new Error('TCP 代理在握手完成前关闭连接'))
    const success = (): void => {
      if (settled) return
      settled = true
      // Return unread TCP banner bytes to the stream before the caller takes ownership.
      socket.pause(); cleanup()
      if (buffer.length) socket.unshift(buffer)
      resolve(socket)
    }
    const take = (count: number): Buffer => { const bytes = buffer.subarray(0, count); buffer = buffer.subarray(count); return bytes }
    const request = (): void => {
      phase = 'reply'
      const port = Buffer.alloc(2); port.writeUInt16BE(targetPort)
      socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(targetHost), port]))
    }
    const data = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        while (!settled) {
          if (phase === 'http') {
            const boundary = buffer.indexOf('\r\n\r\n')
            if (boundary < 0) { if (buffer.length > 32768) throw new Error('HTTP 代理响应头过长'); return }
            if (boundary > 32768) throw new Error('HTTP 代理响应头过长')
            const header = take(boundary + 4).toString('latin1')
            const match = /^HTTP\/1\.[01] (\d{3})(?:[ \t][^\r\n]*)?\r\n/.exec(header)
            if (!match) throw new Error('HTTP 代理响应格式无效')
            const status = Number(match[1])
            if (status === 407) throw new Error('HTTP 代理认证失败 (407)，请检查代理用户名和密码')
            if (status < 200 || status >= 300) throw new Error(`HTTP 代理拒绝 CONNECT (${status})`)
            success(); return
          }
          if (phase === 'method') {
            if (buffer.length < 2) return
            const reply = take(2), method = authenticated ? 2 : 0
            if (reply[0] !== 5 || reply[1] !== method) throw new Error('SOCKS5 代理未接受指定认证方式')
            if (authenticated) { phase = 'auth'; socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([secret.length]), secret])) }
            else request()
          } else if (phase === 'auth') {
            if (buffer.length < 2) return
            const reply = take(2)
            if (reply[0] !== 1 || reply[1] !== 0) throw new Error('SOCKS5 代理认证失败，请检查代理用户名和密码')
            request()
          } else {
            if (buffer.length < 4) return
            if (buffer[0] !== 5 || buffer[2] !== 0) throw new Error('SOCKS5 代理响应格式无效')
            if (buffer[1] !== 0) throw new Error(`SOCKS5 代理拒绝连接 (${buffer[1]})`)
            const type = buffer[3]
            if (type === 3 && buffer.length < 5) return
            const length = type === 1 ? 10 : type === 4 ? 22 : type === 3 && buffer[4] ? 7 + buffer[4] : 0
            if (!length) throw new Error('SOCKS5 代理返回无效地址类型')
            if (buffer.length < length) return
            take(length); success(); return
          }
        }
      } catch (error) { fail(error as Error) }
    }
    // Prevent an unhandled error between handing the socket back and the caller attaching.
    socket.on('error', () => {})
    socket.on('data', data).on('error', failed).once('close', closed).once('end', closed)
    options.signal.addEventListener('abort', abort, { once: true })
    try {
      options.ownSocket(socket)
      if (options.signal.aborted) { abort(); return }
      socket.connect(proxyPort, proxyHost, () => {
        if (settled) return
        if (proxy.type === 'socks5') socket.write(Buffer.from([5, 1, authenticated ? 2 : 0]))
        else {
          const authority = `${isIP(targetHost) === 6 ? '[' + targetHost + ']' : targetHost}:${targetPort}`
          const auth = authenticated ? `Proxy-Authorization: Basic ${Buffer.from(username + ':' + password).toString('base64')}\r\n` : ''
          socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`)
        }
      })
    } catch (error) { fail(error as Error) }
  })
}
