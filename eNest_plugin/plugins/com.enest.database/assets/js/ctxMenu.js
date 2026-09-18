/**
 * ctxMenu.js — 自定义右键菜单（Esc + 点击外部关闭）
 */

let activeMenu = null
let activeCleanup = null

export function closeCtxMenu() {
  if (activeCleanup) {
    try {
      activeCleanup()
    } catch {
      /* ignore */
    }
    activeCleanup = null
  }
  if (activeMenu) {
    activeMenu.remove()
    activeMenu = null
  }
}

/**
 * @param {MouseEvent|{clientX:number,clientY:number}} ev
 * @param {Array<[string,string,{danger?:boolean}|string]|{sep:true}|string>} items
 *   支持：'sep' | [key,label] | [key,label,{danger}] | {key,label,danger}
 * @param {(key:string)=>void} onPick
 */
export function openCtxMenu(ev, items, onPick) {
  closeCtxMenu()
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'
  menu.setAttribute('role', 'menu')

  const list = (items || []).map((it) => {
    if (it === 'sep' || it?.sep) return { sep: true }
    if (Array.isArray(it)) {
      return { key: it[0], label: it[1], danger: !!(it[2] && typeof it[2] === 'object' && it[2].danger) }
    }
    return { key: it.key, label: it.label, danger: !!it.danger }
  })

  menu.innerHTML = list
    .map((it) =>
      it.sep
        ? `<div class="menu-sep" role="separator"></div>`
        : `<button type="button" role="menuitem" data-k="${it.key}" class="${it.danger ? 'danger' : ''}">${escapeHtml(it.label)}</button>`
    )
    .join('')

  document.body.appendChild(menu)
  const rect = menu.getBoundingClientRect()
  const x = Math.min(ev.clientX || 0, window.innerWidth - rect.width - 8)
  const y = Math.min(ev.clientY || 0, window.innerHeight - rect.height - 8)
  menu.style.left = `${Math.max(4, x)}px`
  menu.style.top = `${Math.max(4, y)}px`
  activeMenu = menu

  const onDocPointer = (e) => {
    if (!menu.contains(e.target)) closeCtxMenu()
  }
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeCtxMenu()
    }
  }
  // 下一帧再绑，避免打开手势立刻关闭
  setTimeout(() => {
    document.addEventListener('pointerdown', onDocPointer, true)
    document.addEventListener('keydown', onKey, true)
  }, 0)
  activeCleanup = () => {
    document.removeEventListener('pointerdown', onDocPointer, true)
    document.removeEventListener('keydown', onKey, true)
  }

  menu.querySelectorAll('button[data-k]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.k
      closeCtxMenu()
      onPick?.(k)
    })
  })

  return menu
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 全局 Esc 兜底
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape') closeCtxMenu()
  },
  true
)
