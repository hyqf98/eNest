import { app, utilityProcess } from 'electron'
import { join } from 'node:path'
import { decryptCredential, encryptCredential } from './secureStorage'

const envelope = Buffer.from('eNest:github:gcm:v1\0')
const maxBytes = 32 * 1024

export function isLegacyGithubCiphertext(bytes: Buffer): boolean {
  return process.platform !== 'win32' && /^v\d{2}$/.test(bytes.subarray(0, 3).toString('latin1'))
}

function useAccountStorage(operation: 'seal' | 'open', bytes: Buffer, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  if (!['darwin', 'linux'].includes(process.platform) || !bytes.length || bytes.length > maxBytes) throw new Error('Account storage unavailable')
  const directory = app.isPackaged ? join(process.resourcesPath, 'native') : join(app.getAppPath(), '.cache/native/bin')
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(directory, 'account-storage.cjs'), [], { serviceName: 'eNest account storage', stdio: 'ignore', execArgv: [] })
    let settled = false
    const stop = () => finish()
    const finish = (value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (child.pid !== undefined) child.kill()
      if (value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= maxBytes) {
        const result = Buffer.from(value)
        value.fill(0)
        resolve(result)
      } else reject(new Error('Noninteractive account storage unavailable'))
    }
    const timer = setTimeout(stop, 6000)
    child.once('spawn', () => {
      if (settled) { child.kill(); return }
      try { child.postMessage({ operation, bytes, channel: app.isPackaged ? 'desktop' : 'development' }) } catch { stop() }
    })
    child.once('message', finish)
    child.once('error', stop)
    child.once('exit', stop)
    signal?.addEventListener('abort', stop, { once: true })
  })
}

export async function sealGithubCredential(token: string, signal?: AbortSignal): Promise<Buffer> {
  if (process.platform === 'win32') return encryptCredential(token)
  const plain = Buffer.from(token)
  try { return Buffer.concat([envelope, await useAccountStorage('seal', plain, signal)]) }
  finally { plain.fill(0) }
}

export async function openGithubCredential(bytes: Buffer, signal?: AbortSignal): Promise<Electron.DecryptStringAsyncReturnValue> {
  if (process.platform === 'win32') return decryptCredential(bytes)
  if (!bytes.subarray(0, envelope.length).equals(envelope)) throw new Error('Unrecognized GitHub credential format')
  const plain = await useAccountStorage('open', bytes.subarray(envelope.length), signal)
  try { return { result: plain.toString('utf8'), shouldReEncrypt: false } }
  finally { plain.fill(0) }
}
