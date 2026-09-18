/**
 * tips-global — SSH 插件浮动提示（fixed 挂 body，防 overflow/边框裁切）
 */
;(function () {
  var tipEl = null
  var hideTimer = null

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
      'transition:opacity .1s ease',
      'box-shadow:0 8px 24px rgba(0,0,0,.18)',
      'border:1px solid rgba(0,0,0,.06)'
    ].join(';')
    document.body.appendChild(tipEl)
    return tipEl
  }

  function themeTip(el) {
    var cs = getComputedStyle(document.documentElement)
    el.style.background = cs.getPropertyValue('--text').trim() || '#111'
    el.style.color = cs.getPropertyValue('--bg').trim() || '#fff'
    el.style.borderColor =
      cs.getPropertyValue('--border-strong').trim() || 'rgba(0,0,0,.08)'
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
    var tip = ensureTipEl()
    themeTip(tip)
    tip.textContent = text
    tip.style.opacity = '1'
    var rect = el.getBoundingClientRect()
    var tw = tip.offsetWidth
    var th = tip.offsetHeight
    var gap = 6
    var left = rect.left + rect.width / 2 - tw / 2
    var top = rect.top - th - gap
    if (top < 4) top = rect.bottom + gap
    if (top + th > window.innerHeight - 4) top = Math.max(4, window.innerHeight - th - 4)
    if (left < 4) left = 4
    if (left + tw > window.innerWidth - 4) left = Math.max(4, window.innerWidth - tw - 4)
    tip.style.left = Math.round(left) + 'px'
    tip.style.top = Math.round(top) + 'px'
  }

  function hideTip() {
    if (tipEl) tipEl.style.opacity = '0'
  }

  function applyTip(el) {
    if (!el || el.nodeType !== 1) return
    var text = tipText(el)
    if (text) el.setAttribute('data-tip', text)
  }

  function scanTips(root) {
    var scope = root || document
    scope
      .querySelectorAll(
        'button, [role="button"], .rail-btn, .icon-btn, .fab, .tab-x, [title], [data-tip]'
      )
      .forEach(applyTip)
  }

  function onOver(ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-tip], button[title], [role="button"][title]') : null
    if (!el || !document.contains(el)) return
    var text = tipText(el)
    if (!text) return
    clearTimeout(hideTimer)
    hideTimer = setTimeout(function () {
      placeTip(el, text)
    }, 40)
    if (el.hasAttribute('title') && el.getAttribute('title') === text) {
      el.setAttribute('data-orig-title', text)
      el.removeAttribute('title')
    }
  }

  function onOut(ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-tip], button, [role="button"]') : null
    if (el && el.hasAttribute('data-orig-title')) {
      el.setAttribute('title', el.getAttribute('data-orig-title'))
      el.removeAttribute('data-orig-title')
    }
    clearTimeout(hideTimer)
    hideTimer = setTimeout(hideTip, 60)
  }

  function bindIconTips() {
    scanTips(document)
    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseout', onOut, true)
    document.addEventListener(
      'focusin',
      function (ev) {
        if (ev.target && ev.target.matches && ev.target.matches('[data-tip], button[title]')) {
          onOver({ target: ev.target })
        }
      },
      true
    )
    document.addEventListener('focusout', onOut, true)
    document.addEventListener('scroll', hideTip, true)
    window.addEventListener('resize', hideTip)
    var obs = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        if (m.type === 'attributes' && m.target && m.target.nodeType === 1) {
          applyTip(m.target)
        } else if (m.type === 'childList') {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType === 1) scanTips(n)
          })
        }
      })
    })
    obs.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['title', 'aria-label']
    })
    return function () {
      obs.disconnect()
    }
  }

  function setTip(el, text) {
    if (!el || !text) return
    el.setAttribute('data-tip', text)
    el.setAttribute('title', text)
    el.setAttribute('aria-label', text)
  }

  window.EnestTips = { bindIconTips: bindIconTips, setTip: setTip, scanTips: scanTips }
})()
