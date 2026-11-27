'use strict'
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto')
const port = process.parentPort
if (!port) throw new Error('Account storage requires a host port')

port.once('message', ({ data }) => {
  let key, candidate, input, output
  try {
    if (!['seal', 'open'].includes(data.operation) || !(data.bytes instanceof Uint8Array) || data.bytes.length > 32768) throw new Error()
    input = Buffer.from(data.bytes.buffer, data.bytes.byteOffset, data.bytes.byteLength)
    const seal = data.operation === 'seal'
    if (!seal && input.length <= 28) throw new Error()
    candidate = seal ? randomBytes(32) : Buffer.alloc(0)
    key = require('./account-storage.node')(data.channel, candidate)
    if (seal) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
      const ciphertext = Buffer.concat([cipher.update(input), cipher.final()])
      output = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext])
    } else {
      const cipher = createDecipheriv('aes-256-gcm', key, input.subarray(0, 12))
      cipher.setAuthTag(input.subarray(12, 28))
      output = Buffer.concat([cipher.update(input.subarray(28)), cipher.final()])
    }
    port.postMessage(output)
  } catch { port.postMessage(null) }
  finally { key?.fill(0); candidate?.fill(0); input?.fill(0); output?.fill(0) }
})
