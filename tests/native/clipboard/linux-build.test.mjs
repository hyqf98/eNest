import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDependencies } from '../../../native/clipboard/linux-build.mjs'

test('bundles transitive libraries while retaining the OS loader/glibc family', () => {
  const result = parseDependencies(`
    linux-vdso.so.1 (0x0000ffff91ff0000)
    libjson-glib-1.0.so.0 => /lib/aarch64-linux-gnu/libjson-glib-1.0.so.0 (0x0000ffff91cc0000)
    libXtst.so.6 => /lib/aarch64-linux-gnu/libXtst.so.6   (0x0000ffff91cb0000)
    libpcre2-8.so.0 => /lib/aarch64-linux-gnu/libpcre2-8.so.0 (0x0000ffff91aa0000)
    libgcc_s.so.1 => /lib/aarch64-linux-gnu/libgcc_s.so.1 (0x0000ffff91000000)
    libc.so.6 => /lib/aarch64-linux-gnu/libc.so.6 (0x0000ffff90cc0000)
    libm.so.6 => /lib/aarch64-linux-gnu/libm.so.6 (0x0000ffff90bb0000)
    libpthread.so.0 => /lib/aarch64-linux-gnu/libpthread.so.0 (0x0000ffff90aa0000)
    libdl.so.2 => /lib/aarch64-linux-gnu/libdl.so.2 (0x0000ffff90990000)
    /lib/ld-linux-aarch64.so.1 (0x0000ffff92000000)
  `)
  assert.deepEqual([...result.keys()], ['libjson-glib-1.0.so.0', 'libXtst.so.6', 'libpcre2-8.so.0', 'libgcc_s.so.1'])
  assert.equal(result.get('libXtst.so.6'), '/lib/aarch64-linux-gnu/libXtst.so.6')
})

test('fails the build on unresolved or unrecognized dependencies', () => {
  assert.throws(() => parseDependencies('libXtst.so.6 => not found'), /Unresolved/)
  assert.throws(() => parseDependencies('statically linked'), /Unrecognized/)
  assert.throws(() => parseDependencies('/opt/custom-loader.so (0x000000001000)'), /Unrecognized/)
})

test('rejects library names that could escape the bundle directory', () => {
  assert.throws(() => parseDependencies('../libevil.so => /tmp/evil.so (0x000000001000)'), /Invalid/)
  assert.throws(() => parseDependencies('libevil.so => relative.so (0x000000001000)'), /Invalid/)
})

test('supports the x86_64 loader and rejects an empty non-glibc closure', () => {
  const result = parseDependencies('libX11.so.6 => /lib/x86_64-linux-gnu/libX11.so.6 (0x00007f000000)\n/lib64/ld-linux-x86-64.so.2 (0x00007f100000)')
  assert.equal(result.size, 1)
  assert.throws(() => parseDependencies('libc.so.6 => /lib/libc.so.6 (0x00007f000000)'), /No Linux shared/)
})
