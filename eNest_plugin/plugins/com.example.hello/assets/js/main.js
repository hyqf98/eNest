async function boot() {
  const api = window.enest || window.zapi
  const out = document.getElementById('out')
  if (!api) {
    out.textContent = 'eNest API 不可用（浏览器直开）'
    return
  }
  try {
    await api.ui.setTitle('Hello')
  } catch {
    /* 权限未声明时忽略 */
  }
  const count = Number((await api.settings.get('helloCount')) || 0)
  out.textContent = `打开次数（settings）: ${count}`

  document.getElementById('btn').onclick = async () => {
    // 每次点击重新读取当前值（闭包缓存的 count 只反映打开时的快照）
    const current = Number((await api.settings.get('helloCount')) || 0)
    const next = current + 1
    try {
      await api.settings.set('helloCount', next)
      out.textContent = `打开次数（settings）: ${next}`
    } catch (e) {
      out.textContent = String(e.message || e)
    }
  }
}

void boot()
