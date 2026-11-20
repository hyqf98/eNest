/** 解包 ok/data/error 结构，失败时抛出 Error */
export async function unwrapOk<T>(promise: Promise<{ ok: boolean; data?: T; error?: string }>): Promise<T> {
  const result = await promise
  if (!result?.ok) throw new Error(result?.error || 'ipc failed')
  return result.data as T
}

/** 校验 ok 标志，失败时抛出 Error（无 data 场景） */
export async function expectOk(promise: Promise<{ ok: boolean; error?: string }>): Promise<void> {
  const result = await promise
  if (!result?.ok) throw new Error(result?.error || 'ipc failed')
}
