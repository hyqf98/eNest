import { createServer, createConnection } from 'node:net'
import { once } from 'node:events'

/** Local-only protocol fixture; never follows the requested address off-machine. */
export async function startTestProxy(type, { username = '', password = '', destination, rejectAuth = false } = {}) {
  const peers = new Set(), targets = [], credentials = []
  const server = createServer(socket => {
    peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.on('error', () => {})
    let buffer = Buffer.alloc(0), phase = type === 'http-connect' ? 'http' : 'method'
    const take = n => { const result = buffer.subarray(0, n); buffer = buffer.subarray(n); return result }
    const established = (target, reply) => {
      targets.push(target); phase = 'connected'; socket.removeListener('data', receive)
      if (!destination) { socket.write(reply.subarray(0, 1)); setTimeout(() => socket.write(Buffer.concat([reply.subarray(1), Buffer.from('SSH-2.0-fixture\r\n')])), 4); return }
      const remote = createConnection(destination)
      peers.add(remote); remote.on('close', () => { peers.delete(remote); socket.destroy() }); remote.on('error', () => socket.destroy())
      socket.once('close', () => remote.destroy())
      remote.once('connect', () => {
        socket.write(reply)
        if (buffer.length) remote.write(buffer)
        socket.pipe(remote).pipe(socket)
      })
    }
    const receive = chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (phase === 'http') {
        const boundary = buffer.indexOf('\r\n\r\n'); if (boundary < 0) return
        const header = take(boundary + 4).toString(), target = /^CONNECT (\S+) HTTP\/1.1/.exec(header)?.[1]
        const authorization = /Proxy-Authorization: Basic (\S+)/i.exec(header)?.[1]
        credentials.push(authorization ? Buffer.from(authorization, 'base64').toString() : '')
        if (!target || rejectAuth || username && credentials.at(-1) !== username + ':' + password) { socket.end('HTTP/1.1 407 Secret from proxy must never escape\r\n\r\nbody'); return }
        established(target, Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n')); return
      }
      if (phase === 'method') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
        const hello = take(2 + buffer[1]), method = username ? 2 : 0
        if (!hello.subarray(2).includes(method)) { socket.end(Buffer.from([5, 255])); return }
        phase = username ? 'auth' : 'request'; socket.write(Buffer.from([5])); setTimeout(() => socket.write(Buffer.from([method])), 2)
      }
      if (phase === 'auth') {
        if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return
        const ulen = buffer[1], plen = buffer[2 + ulen], length = 3 + ulen + plen
        if (buffer.length < length) return
        const auth = take(length), user = auth.subarray(2, 2 + ulen).toString(), secret = auth.subarray(3 + ulen).toString()
        credentials.push(user + ':' + secret)
        if (rejectAuth || user !== username || secret !== password) { socket.end(Buffer.from([1, 1])); return }
        phase = 'request'; socket.write(Buffer.from([1, 0]))
      }
      if (phase === 'request') {
        if (buffer.length < 5) return
        const type = buffer[3], length = type === 1 ? 10 : type === 4 ? 22 : 7 + buffer[4]
        if (buffer.length < length) return
        const request = take(length), host = type === 3 ? request.subarray(5, -2).toString() : type === 1 ? [...request.subarray(4, 8)].join('.') : request.subarray(4, 20).toString('hex')
        established(host + ':' + request.readUInt16BE(length - 2), Buffer.concat([Buffer.from([5, 0, 0, 4]), Buffer.alloc(18)]))
      }
    }
    socket.on('data', receive)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { port: server.address().port, targets, credentials, close: async () => { for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)) } }
}
