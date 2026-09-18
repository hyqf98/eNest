/**
 * tips.js — 图标按钮悬停功能名
 * 将 title 同步到 data-tip（CSS 即时气泡），并监听动态插入节点。
 */
function applyTip(el) {
  if (!el || el.nodeType !== 1) return
  const title = el.getAttribute('title') || el.getAttribute('aria-label') || ''
  if (!title) {
    el.removeAttribute('data-tip')
    return
  }
  el.setAttribute('data-tip', title)
  if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', title)
}

function scanTips(root) {
  const scope = root || document
  scope
    .querySelectorAll('button[title], button[aria-label], [role="button"][title], .rail-btn, .icon-btn, .fab, .fab-execute, .fab-more, .btn.icon, .tab-x')
    .forEach(applyTip)
}

export function bindIconTips() {
  scanTips(document)
  // title 被脚本改写时同步 data-tip
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes' && m.target instanceof Element) {
        if (m.attributeName === 'title' || m.attributeName === 'aria-label') {
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
  return () => obs.disconnect()
}

export function setTip(el, text) {
  if (!el) return
  el.setAttribute('title', text)
  el.setAttribute('aria-label', text)
  el.setAttribute('data-tip', text)
}
