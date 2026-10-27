import { safeStorage } from 'electron'

const LINUX_SECURE_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])

async function assertSecureStorage(): Promise<void> {
  if (!await safeStorage.isAsyncEncryptionAvailable()
    || process.platform === 'linux' && !LINUX_SECURE_BACKENDS.has(safeStorage.getSelectedStorageBackend())) {
    throw new Error('secure credential storage unavailable; unlock or configure the system keyring and retry')
  }
}

function assertSecureCiphertext(encrypted: Buffer): void {
  // Chromium's Linux Posix fallback uses the public fixed-key v10 format even
  // when the async encryptor initialized successfully. macOS v10 is not this fallback.
  if (process.platform === 'linux' && encrypted.subarray(0, 3).toString('ascii') === 'v10') {
    throw new Error('secure credential storage unavailable; Linux basic-text fallback is not permitted')
  }
}

export async function encryptCredential(plainText: string): Promise<Buffer> {
  await assertSecureStorage()
  const encrypted = await safeStorage.encryptStringAsync(plainText)
  assertSecureCiphertext(encrypted)
  return encrypted
}

export async function decryptCredential(encrypted: Buffer): Promise<Electron.DecryptStringAsyncReturnValue> {
  await assertSecureStorage()
  assertSecureCiphertext(encrypted)
  return safeStorage.decryptStringAsync(encrypted)
}
