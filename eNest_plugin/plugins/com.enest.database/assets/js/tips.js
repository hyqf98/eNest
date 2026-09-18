/**
 * tips — 浮动提示（position:fixed 挂 body，避免被 overflow/边框裁切）
 * 兼容 title / aria-label / data-tip；鼠标悬停与键盘焦点均显示。
 */
let tipEl = null
let hideTimer = null

function ensureTipEl() {
  if (tipEl && document.body.contains(tipEl)) return tipEl
  tipEl = document.createElement('div')
  tipEl.className = 'enest-float-tip'
  tipEl.setAttribute('role', 'tooltip')
  tipEl.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'z-index:2147483000',
    'max-width:280px',
    'padding:4px 8px',
    'border-radius:8px',
    'font-size:11px',
    'font-weight:500',
    'line-height:1.3',
    'white-space:nowrap',
    'pointer-events:none',
    'opacity:0',
    'transform:translateY(2px)',
    'transition:opacity .1s ease',
    'box-shadow:0 8px 24px rgba(0,0,0,.18)',
    'border:1px solid rgba(0,0,0,.06)'
  ].join(';')
  document.body.appendChild(tipEl)
  return tipEl
}

function themeTip(el) {
  const cs = getComputedStyle(document.documentElement)
  const bg = cs.getPropertyValue('--text').trim() || '#111'
  const fg = cs.getPropertyValue('--bg').trim() || '#fff'
  const border = cs.getPropertyValue('--border-strong').trim() || 'rgba(0,0,0,.08)'
  el.style.background = bg
  el.style.color = fg
  el.style.borderColor = border
}

function tipText(el) {
  return (
    el.getAttribute('data-tip') ||
    el.getAttribute('title') ||
    el.getAttribute('aria-label') ||
    ''
  ).trim()
}

function placeTip(el, text) {
  const tip = ensureTipEl()
  themeTip(tip)
  tip.textContent = text
  tip.style.opacity = '1'
  tip.style.transform = 'translateY(0)'
  const rect = el.getBoundingClientRect()
  const tw = tip.offsetWidth
  const th = tip.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight
  const gap = 6
  // 默认上方；放不下再下方；再夹到视口内
  let left = rect.left + rect.width / 2 - tw / 2
  let top = rect.top - th - gap
  if (top < 4) top = rect.bottom + gap
  if (top + th > vh - 4) top = Math.max(4, vh - th - 4)
  if (left < 4) left = 4
  if (left + tw > vw - 4) left = Math.max(4, vw - tw - 4)
  tip.style.left = Math.round(left) + 'px'
  tip.style.top = Math.round(top) + 'px'
}

function hideTip() {
  if (!tipEl) return
  tipEl.style.opacity = '0'
  tipEl.style.transform = 'translateY(2px)'
}

function applyTip(el) {
  if (!el || el.nodeType !== 1) return
  const text = tipText(el)
  if (text) el.setAttribute('data-tip', text)
}

function scanTips(root) {
  const scope = root || document
  scope
    .querySelectorAll(
      'button, [role="button"], .rail-btn, .icon-btn, .fab, .fab-execute, .fab-more, .btn.icon, .tab-x, [title], [data-tip]'
    )
    .forEach(applyTip)
}

function onOver(ev) {
  const el = ev.target?.closest?.('[data-tip], button[title], [role="button"][title]')
  if (!el || !document.contains(el)) return
  const text = tipText(el)
  if (!text) return
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => placeTip(el, text), 40)
  // 避免原生 title 气泡叠在一起
  if (el.hasAttribute('title') && el.getAttribute('title') === text) {
    el.setAttribute('data-orig-title', text)
    el.removeAttribute('title')
  }
}

function onOut(ev) {
  const el = ev.target?.closest?.('[data-tip], button, [role="button"]')
  if (el && el.hasAttribute('data-orig-title')) {
    el.setAttribute('title', el.getAttribute('data-orig-title'))
    el.removeAttribute('data-orig-title')
  }
  clearTimeout(hideTimer)
  hideTimer = setTimeout(hideTip, 60)
}

export function bindIconTips() {
  scanTips(document)
  document.addEventListener('mouseover', onOver, true)
  document.addEventListener('mouseout', onOut, true)
  document.addEventListener('focusin', (ev) => {
    const el = ev.target
    if (el && el.matches?.('[data-tip], button[title]')) onOver({ target: el })
  })
  document.addEventListener('focusout', onOut, true)
  document.addEventListener('scroll', hideTip, true)
  window.addEventListener('resize', hideTip)
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes' && m.target instanceof Element) {
        if (['title', 'aria-label', 'data-tip'].includes(m.attributeName || '')) {
          applyTip(m.target)
        }
      } else if (m.type === 'childList') {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 1) scanTips(n)
        })
      }
    }
  })
  obs.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['title', 'aria-label']
  })
  return () => {
    obs.disconnect()
    document.removeEventListener('mouseover', onOver, true)
    document.removeEventListener('mouseout', onOut, true)
  }
}

export function setTip(el, text) {
  if (!el) return
  if (text) {
    el.setAttribute('data-tip', text)
    el.setAttribute('aria-label', text)
    // title 交给悬浮层消费，避免原生气泡遮挡
    el.setAttribute('title', text)
  }
}
