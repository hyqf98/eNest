/**
 * editor.js — 轻量多 Tab SQL 编辑器（DB-E1）
 * textarea + 高亮层叠加；补全浮层；快捷键
 */
import { highlightHtml, statementAtCursor } from './tokenizer.js'
import {
  requestCompletion,
  filterItems,
  applyCompletionItem,
  kindMeta
} from './completion.js'
import { state, activeSession, activeEditor, updateSessionEditorSql } from './store.js'
import { toast } from './api.js'

export class SqlEditor {
  constructor(root, opts = {}) {
    this.root = root
    this.onChange = opts.onChange || (() => {})
    this.onExecute = opts.onExecute || (() => {})
    this.onExecuteAll = opts.onExecuteAll || (() => {})
    this.onSave = opts.onSave || (() => {})
    this.getSessionKey = opts.getSessionKey || (() => '')
    this.getDialect = opts.getDialect || (() => 'mysql')
    this.getCompletionScope = opts.getCompletionScope || (() => ({}))
    this.completionTimer = null
    this.completionState = null
    this.dialect = 'mysql'
    this.perfMode = false
    this._build()
    this._bind()
  }

  _build() {
    this.root.innerHTML = `
      <div class="sql-editor">
        <div class="gutter" data-el="gutter"></div>
        <div class="editor-scroll">
          <div class="editor-wrap">
            <pre class="hl" data-el="hl" aria-hidden="true"></pre>
            <textarea class="ta" data-el="ta" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>
          </div>
          <div class="current-line" data-el="curline"></div>
        </div>
        <div class="completion-popup" data-el="popup" hidden></div>
        <div class="completion-doc" data-el="doc" hidden></div>
        <div class="editor-findbar" data-el="findbar" hidden>
          <input data-el="findInput" placeholder="查找…" />
          <input data-el="replInput" placeholder="替换…" />
          <button type="button" class="btn" data-act="find-next">下一个</button>
          <button type="button" class="btn" data-act="repl">替换</button>
          <button type="button" class="btn" data-act="repl-all">全部</button>
          <button type="button" class="btn ghost" data-act="find-close">关闭</button>
        </div>
      </div>
    `
    this.el = {
      gutter: this.root.querySelector('[data-el=gutter]'),
      hl: this.root.querySelector('[data-el=hl]'),
      ta: this.root.querySelector('[data-el=ta]'),
      curline: this.root.querySelector('[data-el=curline]'),
      popup: this.root.querySelector('[data-el=popup]'),
      doc: this.root.querySelector('[data-el=doc]'),
      findbar: this.root.querySelector('[data-el=findbar]'),
      findInput: this.root.querySelector('[data-el=findInput]'),
      replInput: this.root.querySelector('[data-el=replInput]')
    }
  }

  querySelector(sel) {
    return this.root.querySelector(sel)
  }

  _bind() {
    const ta = this.el.ta
    ta.addEventListener('input', () => this._handleInput())
    ta.addEventListener('scroll', () => this._syncScroll())
    ta.addEventListener('keyup', (e) => {
      if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        if (this.completionState?.open) {
          e.preventDefault()
          return
        }
        this._highlight()
      }
    })
    ta.addEventListener('keydown', (e) => this._handleKeydown(e))
    ta.addEventListener('click', () => {
      if (this.completionState?.open) this.closeCompletion()
      this._highlight()
    })
    ta.addEventListener('blur', () => {
      // 点击补全项前延迟关闭
      setTimeout(() => {
        if (!this.el.popup.contains(document.activeElement)) this.closeCompletion()
      }, 120)
    })

    this.el.popup.addEventListener('mousedown', (e) => {
      const item = e.target.closest('[data-idx]')
      if (!item) return
      e.preventDefault()
      this.acceptCompletion(Number(item.dataset.idx))
    })
    this.el.popup.addEventListener('mousemove', (e) => {
      const item = e.target.closest('[data-idx]')
      if (!item) return
      const idx = Number(item.dataset.idx)
      if (this.completionState && this.completionState.index !== idx) {
        this.completionState.index = idx
        this._renderCompletion()
      }
    })

    this.root.querySelector('[data-act=find-close]')?.addEventListener('click', () => {
      this.el.findbar.hidden = true
    })
    this.root.querySelector('[data-act=find-next]')?.addEventListener('click', () => this._findNext())
    this.root.querySelector('[data-act=repl]')?.addEventListener('click', () => this._replaceOne())
    this.root.querySelector('[data-act=repl-all]')?.addEventListener('click', () => this._replaceAll())
  }

  setDialect(dialect) {
    this.dialect = dialect || 'mysql'
    this._highlight()
  }

  setValue(sql, { cursor, silent } = {}) {
    this.el.ta.value = sql || ''
    if (cursor) {
      const pos = this._offsetFromLineCh(cursor)
      try {
        this.el.ta.setSelectionRange(pos, pos)
      } catch {
        /* ignore */
      }
    }
    this.perfMode = (sql || '').length > 200_000
    this._highlight()
    if (!silent) this.onChange(this.getValue(), this.getCursor())
  }

  getValue() {
    return this.el.ta.value
  }

  getCursor() {
    return this.getLineCh(this.el.ta.selectionStart)
  }

  getLineCh(offset) {
    const text = this.el.ta.value.slice(0, offset)
    const lines = text.split('\n')
    return { line: lines.length - 1, ch: lines[lines.length - 1].length }
  }

  _offsetFromLineCh({ line = 0, ch = 0 } = {}) {
    const lines = this.el.ta.value.split('\n')
    let off = 0
    for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1
    return off + ch
  }

  focus() {
    this.el.ta.focus()
  }

  _handleInput() {
    const sql = this.getValue()
    this.perfMode = sql.length > 200_000
    this._highlight()
    this.onChange(sql, this.getCursor())
    this._scheduleCompletion(false)
  }

  _handleKeydown(e) {
    const mod = e.metaKey || e.ctrlKey
    // 补全导航
    if (this.completionState?.open) {
      const st = this.completionState
      if (e.key === 'Escape') {
        e.preventDefault()
        this.closeCompletion()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        st.index = (st.index + 1) % Math.max(1, st.items.length)
        this._renderCompletion()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        st.index = (st.index - 1 + st.items.length) % Math.max(1, st.items.length)
        this._renderCompletion()
        return
      }
      if (e.key === 'PageDown') {
        e.preventDefault()
        st.index = Math.min(st.items.length - 1, st.index + 8)
        this._renderCompletion()
        return
      }
      if (e.key === 'PageUp') {
        e.preventDefault()
        st.index = Math.max(0, st.index - 8)
        this._renderCompletion()
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        this.acceptCompletion(st.index)
        return
      }
    }

    if (mod && e.code === 'Space') {
      e.preventDefault()
      this.triggerCompletion(true)
      return
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) this.onExecuteAll()
      else this.onExecute({ mode: 'current' })
      return
    }
    if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      this.onSave()
      return
    }
    if (mod && e.key === '/') {
      e.preventDefault()
      this.toggleComment()
      return
    }
    if (mod && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault()
      this.el.findbar.hidden = false
      this.el.findInput.focus()
      return
    }
    if (e.key === 'F5') {
      e.preventDefault()
      this.onExecute({ mode: 'current' })
      return
    }
    if (e.key === 'Tab' && !mod) {
      e.preventDefault()
      this._indent(e.shiftKey ? -1 : 1)
      return
    }
  }

  _indent(dir) {
    const ta = this.el.ta
    const { selectionStart, selectionEnd, value } = ta
    const startLine = value.slice(0, selectionStart).split('\n').length - 1
    const endLine = value.slice(0, selectionEnd).split('\n').length - 1
    const lines = value.split('\n')
    if (startLine === endLine && dir > 0) {
      const pos = selectionStart
      ta.value = value.slice(0, pos) + '  ' + value.slice(selectionEnd)
      ta.setSelectionRange(pos + 2, pos + 2)
    } else {
      for (let i = startLine; i <= endLine && i < lines.length; i++) {
        if (dir > 0) lines[i] = '  ' + lines[i]
        else lines[i] = lines[i].replace(/^ {1,2}/, '')
      }
      ta.value = lines.join('\n')
    }
    this._highlight()
    this.onChange(ta.value, this.getCursor())
  }

  toggleComment() {
    const ta = this.el.ta
    const { selectionStart, selectionEnd, value } = ta
    const lines = value.split('\n')
    const startLine = value.slice(0, selectionStart).split('\n').length - 1
    const endLine = value.slice(0, selectionEnd).split('\n').length - 1
    const slice = lines.slice(startLine, endLine + 1)
    const allCommented = slice.every((l) => !l.trim() || l.trimStart().startsWith('--'))
    for (let i = startLine; i <= endLine && i < lines.length; i++) {
      if (allCommented) lines[i] = lines[i].replace(/^(\s*)--\s?/, '$1')
      else if (lines[i].trim()) lines[i] = '-- ' + lines[i]
    }
    ta.value = lines.join('\n')
    this._highlight()
    this.onChange(ta.value, this.getCursor())
  }

  _syncScroll() {
    const { scrollTop, scrollLeft } = this.el.ta
    const scrollParent = this.root.querySelector('.editor-scroll')
    if (scrollParent) {
      // ta 是滚动主体；同步高亮层即可
    }
    this.el.hl.scrollTop = scrollTop
    this.el.hl.scrollLeft = scrollLeft
    this.el.gutter.scrollTop = scrollTop
  }

  _highlight() {
    const sql = this.el.ta.value
    const dialect = this.getDialect() || this.dialect
    if (this.perfMode) {
      this.el.hl.textContent = sql
      this.el.gutter.textContent = sql
        .split('\n')
        .map((_, i) => i + 1)
        .join('\n')
    } else {
      this.el.hl.innerHTML = highlightHtml(sql, dialect) + '\n'
      const lineCount = sql.split('\n').length
      let gut = ''
      for (let i = 1; i <= lineCount; i++) gut += i + '\n'
      this.el.gutter.textContent = gut
    }
    this._highlightCurrentLine()
  }

  _highlightCurrentLine() {
    const cursor = this.getCursor()
    const taStyle = getComputedStyle(this.el.ta)
    const lh = parseFloat(taStyle.lineHeight) || 20
    const pad = parseFloat(taStyle.paddingTop) || 8
    this.el.curline.style.top = `${pad + cursor.line * lh - this.el.ta.scrollTop}px`
    this.el.curline.style.height = `${lh}px`
  }

  _scheduleCompletion(isManual) {
    clearTimeout(this.completionTimer)
    this.completionTimer = setTimeout(() => this.triggerCompletion(isManual), isManual ? 0 : 70)
  }

  async triggerCompletion(force) {
    const ta = this.el.ta
    const sql = ta.value
    const cursor = ta.selectionStart
    const ch = cursor > 0 ? sql[cursor - 1] : ''
    const isWord = /[A-Za-z0-9_$\u4e00-\u9fff]/.test(ch)
    const isDot = ch === '.'
    if (!force && !isWord && !isDot) {
      this.closeCompletion()
      return
    }
    const stmt = statementAtCursor(sql, cursor)
    const sessionKey = this.getSessionKey()
    const dialect = this.getDialect() || this.dialect
    const scope = this.getCompletionScope() || {}
    try {
      const res = await requestCompletion({
        sessionKey,
        sql,
        cursor,
        dialect,
        statementSql: stmt.sql,
        database: scope.database,
        schema: scope.schema,
        usageBoost: scope.usageBoost
      })
      const prefix = this._prefixAt(sql, cursor)
      const items =
        force && !prefix ? res.items || [] : filterItems(res.items || [], prefix)
      this.completionState = {
        open: true,
        items,
        index: 0,
        replace: res.replace || { from: cursor, to: cursor },
        local: !!res._local,
        source: sql,
        cursor
      }
      this._renderCompletion()
    } catch (e) {
      // 自动触发静默；手动 Ctrl+Space 才提示
      if (force) {
        const msg = e?.code === 'HOST_LAG' || e?.code === 'NO_API' ? '补全暂不可用' : String(e.message || e)
        toast(msg, 'warn')
      }
      this.closeCompletion()
    }
  }

  _prefixAt(sql, cursor) {
    let i = cursor
    while (i > 0 && /[A-Za-z0-9_$\u4e00-\u9fff]/.test(sql[i - 1])) i--
    return sql.slice(i, cursor)
  }

  _renderCompletion() {
    const st = this.completionState
    const popup = this.el.popup
    const doc = this.el.doc
    if (!st?.open || !st.items?.length) {
      if (st?.open) {
        popup.hidden = false
        popup.innerHTML = '<div class="comp-empty">无建议</div>'
        doc.hidden = true
        this._placePopup()
      } else {
        popup.hidden = true
        doc.hidden = true
      }
      return
    }
    popup.hidden = false
    const rows = st.items
      .map((it, idx) => {
        const meta = kindMeta(it.kind)
        const active = idx === st.index ? ' active' : ''
        const detail = it.detail ? `<span class="comp-detail">${escape(it.detail)}</span>` : ''
        return `<div class="comp-item${active}" data-idx="${idx}">
          <span class="comp-kind" style="background:${meta.color}"></span>
          <span class="comp-label">${escape(it.label)}</span>
          ${detail}
        </div>`
      })
      .join('')
    popup.innerHTML = rows
    this._placePopup()
    const active = popup.querySelector('.comp-item.active')
    active?.scrollIntoView({ block: 'nearest' })

    const item = st.items[st.index]
    if (item?.doc || item?.detail || item?.owner) {
      doc.hidden = false
      doc.innerHTML = `
        <div class="doc-kind">${kindMeta(item.kind).label}${item.owner ? ' · ' + escape(item.owner) : ''}</div>
        <div class="doc-label">${escape(item.label)}</div>
        ${item.detail ? `<div class="doc-detail">${escape(item.detail)}</div>` : ''}
        ${item.doc ? `<div class="doc-body">${escape(item.doc)}</div>` : ''}
        ${item.insertText && item.insertText !== item.label ? `<div class="doc-insert"><code>${escape(item.insertText)}</code></div>` : ''}
        ${st.local ? '<div class="doc-note">本地回退词库</div>' : ''}
      `
    } else {
      doc.hidden = true
    }
  }

  _placePopup() {
    const ta = this.el.ta
    const popup = this.el.popup
    const cursor = ta.selectionStart
    // 估算光标像素
    const before = ta.value.slice(0, cursor)
    const lines = before.split('\n')
    const line = lines.length - 1
    const col = lines[lines.length - 1].length
    const taStyle = getComputedStyle(ta)
    const lh = parseFloat(taStyle.lineHeight) || 20
    const chW = parseFloat(taStyle.fontSize) * 0.6
    const padT = parseFloat(taStyle.paddingTop) || 8
    const padL = parseFloat(taStyle.paddingLeft) || 8
    const x = padL + col * chW - ta.scrollLeft
    const y = padT + (line + 1) * lh - ta.scrollTop
    const wrap = this.root.querySelector('.editor-wrap')
    const wr = wrap.getBoundingClientRect()
    const er = this.root.getBoundingClientRect()
    const left = x + (wrap.offsetLeft || 40)
    const top = y + (wrap.offsetTop || 0)
    popup.style.left = `${Math.min(left, er.width - 280)}px`
    popup.style.top = `${Math.min(top, er.height - 200)}px`
    void wr
  }

  acceptCompletion(idx) {
    const st = this.completionState
    if (!st?.open || !st.items?.length) return
    const item = st.items[idx]
    if (!item) return
    const ta = this.el.ta
    const from = st.replace?.from ?? st.cursor
    const to = st.replace?.to ?? st.cursor
    let text = item.insertText || item.label
    // 表名应用后可选默认别名（设置 autoAliasAfterTable）
    const scope = this.getCompletionScope?.() || {}
    if (
      (item.kind === 'table' || item.kind === 'view' || item.kind === 'measurement') &&
      scope.autoAliasAfterTable
    ) {
      const base = String(item.label || text).split('.').pop().replace(/["`]/g, '')
      const alias = base.slice(0, 1) || 't'
      if (!/^\s+as\s+/i.test(text)) text = `${text} AS ${alias}`
    }
    const value = ta.value
    ta.value = value.slice(0, from) + text + value.slice(to)
    const pos = from + text.length
    ta.setSelectionRange(pos, pos)
    applyCompletionItem(item)
    this.closeCompletion()
    this._highlight()
    this.onChange(ta.value, this.getCursor())
    ta.focus()
  }

  closeCompletion() {
    if (this.completionState) this.completionState.open = false
    this.el.popup.hidden = true
    this.el.doc.hidden = true
  }

  getSelectionOrStatement(mode) {
    const ta = this.el.ta
    const sql = ta.value
    const selStart = ta.selectionStart
    const selEnd = ta.selectionEnd
    if (mode === 'all') return { sql, start: 0, end: sql.length }
    if (mode === 'selection' || (selStart !== selEnd && mode !== 'current')) {
      return { sql: sql.slice(selStart, selEnd), start: selStart, end: selEnd }
    }
    const stmt = statementAtCursor(sql, selStart)
    return stmt
  }

  _findNext() {
    const q = this.el.findInput.value
    if (!q) return
    const ta = this.el.ta
    const from = ta.selectionEnd
    const idx = ta.value.indexOf(q, from)
    const idx2 = idx >= 0 ? idx : ta.value.indexOf(q)
    if (idx2 < 0) {
      toast('未找到', 'warn')
      return
    }
    ta.focus()
    ta.setSelectionRange(idx2, idx2 + q.length)
  }

  _replaceOne() {
    const ta = this.el.ta
    const q = this.el.findInput.value
    const r = this.el.replInput.value
    if (!q) return
    const { selectionStart, selectionEnd, value } = ta
    if (value.slice(selectionStart, selectionEnd) === q) {
      ta.value = value.slice(0, selectionStart) + r + value.slice(selectionEnd)
      ta.setSelectionRange(selectionStart + r.length, selectionStart + r.length)
      this._highlight()
      this.onChange(ta.value, this.getCursor())
    }
    this._findNext()
  }

  _replaceAll() {
    const ta = this.el.ta
    const q = this.el.findInput.value
    const r = this.el.replInput.value
    if (!q) return
    const count = ta.value.split(q).length - 1
    ta.value = ta.value.split(q).join(r)
    this._highlight()
    this.onChange(ta.value, this.getCursor())
    toast(`已替换 ${count} 处`, 'success')
  }
}

function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function bindEditorToStore(editor) {
  editor.onChange = (sql, cursor) => {
    const ed = activeEditor()
    if (!ed) return
    updateSessionEditorSql(ed, sql, cursor)
  }
  void state
  void activeSession
}
