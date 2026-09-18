/**
 * com.enest.ssh — 终端适配层
 * 优先 vendored xterm.js；不可用时降级为 textarea+pre 流式终端（仍可交互）。
 */
;(function (global) {
  function cssVar(name, fallback) {
    try {
      return (
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
      )
    } catch {
      return fallback
    }
  }

  function stripAnsi(s) {
    return String(s)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '')
      .replace(/\r(?!\n)/g, '\n')
  }

  function termThemeFromCss() {
    return {
      background: cssVar('--term-bg', '#0b0f14'),
      foreground: cssVar('--text', '#e8eef7'),
      cursor: cssVar('--accent', '#e8ecf4'),
      cursorAccent: cssVar('--term-bg', '#0b0f14'),
      selectionBackground: cssVar('--accent-soft', 'rgba(232,236,244,0.22)'),
      black: '#1c2330',
      red: '#ff6b7a',
      green: '#3dd68c',
      yellow: '#f5b942',
      blue: '#5b8cff',
      magenta: '#c792ea',
      cyan: '#56c8d8',
      white: '#e8eef7',
      brightBlack: '#6b7789',
      brightRed: '#ff8b98',
      brightGreen: '#6ee7b0',
      brightYellow: '#ffd27a',
      brightBlue: '#8eb0ff',
      brightMagenta: '#d7b3f5',
      brightCyan: '#8adce8',
      brightWhite: '#ffffff',
    }
  }

  /** 本地 PTY 尺寸估算（xterm 不可用时） */
  function estimateSize(el) {
    const w = el.clientWidth || 800
    const h = el.clientHeight || 400
    const fontSize = Number(SshStore?.state?.ui?.fontSize) || 13
    const charW = Math.max(7, Math.floor(fontSize * 0.6))
    const charH = Math.max(12, Math.floor(fontSize * 1.25))
    return {
      cols: Math.max(20, Math.floor(w / charW) - 2),
      rows: Math.max(8, Math.floor(h / charH) - 1),
    }
  }

  /**
   * createTerminal(container, handlers)
   * handlers: { onData(data), onResize(cols, rows), onSelection() }
   * returns TerminalHandle
   */
  function createTerminal(container, handlers) {
    const opts = SshStore?.state?.ui || {}
    const fontSize = Number(opts.fontSize) || 13
    const fontFamily =
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "PingFang SC", monospace'

    const TermCtor = global.Terminal
    const FitClass =
      (global.FitAddon && (global.FitAddon.FitAddon || global.FitAddon)) ||
      global.FitAddon ||
      null

    container.innerHTML = ''

    if (typeof TermCtor === 'function') {
      const term = new TermCtor({
        cursorBlink: true,
        fontSize,
        fontFamily,
        scrollback: 5000,
        convertEol: false,
        theme: termThemeFromCss(),
        allowProposedApi: true,
      })
      let fit = null
      if (typeof FitClass === 'function') {
        try {
          fit = new FitClass()
          term.loadAddon(fit)
        } catch {
          fit = null
        }
      }
      term.open(container)

      const resizeNow = () => {
        try {
          if (fit) fit.fit()
        } catch { /* ignore */ }
        const cols = term.cols || 80
        const rows = term.rows || 24
        if (handlers && handlers.onResize) handlers.onResize(cols, rows)
      }

      // 延迟 fit，确保布局完成
      requestAnimationFrame(() => resizeNow())

      let ro
      try {
        ro = new ResizeObserver(() => resizeNow())
        ro.observe(container)
      } catch {
        window.addEventListener('resize', resizeNow)
      }

      term.onData((data) => {
        if (handlers && handlers.onData) handlers.onData(data)
      })

      const selTimer = { t: null }
      term.onSelectionChange(() => {
        if (!SshStore?.state?.ui?.selectCopy) return
        clearTimeout(selTimer.t)
        selTimer.t = setTimeout(() => {
          try {
            const sel = term.getSelection()
            if (sel && handlers && handlers.onSelection) handlers.onSelection(sel)
          } catch { /* ignore */ }
        }, 120)
      })

      return {
        kind: 'xterm',
        el: container,
        write(data) {
          try {
            term.write(typeof data === 'string' ? data : new Uint8Array(data))
          } catch {
            try { term.write(String(data)) } catch { /* ignore */ }
          }
        },
        writeln(data) {
          try { term.writeln(String(data)) } catch { /* ignore */ }
        },
        focus() { try { term.focus() } catch { /* ignore */ } },
        clear() { try { term.clear() } catch { /* ignore */ } },
        fit: resizeNow,
        getSize() {
          return { cols: term.cols || 80, rows: term.rows || 24 }
        },
        setTheme() {
          try { term.options.theme = termThemeFromCss() } catch { /* ignore */ }
        },
        setFontSize(px) {
          try {
            term.options.fontSize = px
            resizeNow()
          } catch { /* ignore */ }
        },
        getSelection() {
          try { return term.getSelection() } catch { return '' }
        },
        searchNext(q) {
          // 无 search addon 时降级为页面查找不可用提示
          if (!q) return false
          try {
            if (term.__enestSearch && term.__enestSearch.findNext) {
              return Boolean(term.__enestSearch.findNext(q))
            }
          } catch { /* ignore */ }
          return false
        },
        dispose() {
          try { ro && ro.disconnect() } catch { /* ignore */ }
          try { term.dispose() } catch { /* ignore */ }
          container.innerHTML = ''
        },
        raw: term,
      }
    }

    /* —— fallback：pre 输出 + 隐藏 input 键入 —— */
    const pre = document.createElement('pre')
    pre.className = 'term-fallback'
    pre.tabIndex = 0
    pre.setAttribute('aria-label', '终端输出（降级模式）')
    const hidden = document.createElement('textarea')
    hidden.setAttribute('aria-hidden', 'true')
    hidden.style.cssText =
      'position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;left:-9999px;'
    container.appendChild(pre)
    container.appendChild(hidden)

    let buffer = ''
    const MAX = 200000

    function render() {
      let text = stripAnsi(buffer)
      if (text.length > MAX) text = text.slice(-MAX)
      pre.textContent = text
      pre.scrollTop = pre.scrollHeight
    }

    function append(data) {
      buffer += typeof data === 'string' ? data : String(data)
      render()
    }

    function send(data) {
      if (handlers && handlers.onData) handlers.onData(data)
    }

    function resizeNow() {
      const size = estimateSize(pre.parentElement || container)
      if (handlers && handlers.onResize) handlers.onResize(size.cols, size.rows)
    }

    const roFallback = (() => {
      try {
        const r = new ResizeObserver(() => resizeNow())
        r.observe(container)
        return r
      } catch {
        window.addEventListener('resize', resizeNow)
        return null
      }
    })()

    const onKeyDown = (ev) => {
      // 字符级转发，兼容密码提示
      if (ev.key === 'Enter') {
        ev.preventDefault()
        append('\n')
        send('\r')
        return
      }
      if (ev.key === 'Backspace') {
        ev.preventDefault()
        send('\x7f')
        return
      }
      if (ev.key === 'Tab') {
        ev.preventDefault()
        send('\t')
        return
      }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); send('\x1b[A'); return }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); send('\x1b[B'); return }
      if (ev.key === 'ArrowRight') { ev.preventDefault(); send('\x1b[C'); return }
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); send('\x1b[D'); return }
      if (ev.ctrlKey && ev.key.length === 1) {
        ev.preventDefault()
        const code = ev.key.toUpperCase().charCodeAt(0)
        if (code >= 64 && code <= 95) send(String.fromCharCode(code - 64))
        return
      }
      if (ev.metaKey || ev.altKey) return
      if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault()
        send(ev.key)
      }
    }

    pre.addEventListener('keydown', onKeyDown)
    pre.addEventListener('paste', (ev) => {
      ev.preventDefault()
      const text = (ev.clipboardData || window.clipboardData).getData('text')
      if (text) send(text)
    })
    pre.addEventListener('click', () => pre.focus())
    requestAnimationFrame(() => resizeNow())

    return {
      kind: 'fallback',
      el: container,
      write: append,
      writeln(data) { append(String(data) + '\n') },
      focus() { pre.focus() },
      clear() { buffer = ''; render() },
      fit: resizeNow,
      getSize() { return estimateSize(pre.parentElement || container) },
      setTheme() { /* CSS 变量已生效 */ },
      setFontSize(px) {
        pre.style.fontSize = px + 'px'
        resizeNow()
      },
      getSelection() {
        try { return String(window.getSelection() || '') } catch { return '' }
      },
      searchNext(q) {
        if (!q) return false
        return stripAnsi(buffer).toLowerCase().includes(String(q).toLowerCase())
      },
      dispose() {
        try { roFallback && roFallback.disconnect() } catch { /* ignore */ }
        pre.removeEventListener('keydown', onKeyDown)
        container.innerHTML = ''
      },
      raw: null,
    }
  }

  global.SshTerm = {
    createTerminal,
    termThemeFromCss,
    stripAnsi,
  }
})(window)
