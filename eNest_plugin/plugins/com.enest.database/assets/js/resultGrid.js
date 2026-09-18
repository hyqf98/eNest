/**
 * resultGrid.js — 结果网格：虚拟滚动、行状态 CRUD、变更集
 * 可见控件极少：状态徽标；选中行/有脏变更时出现选择条
 * 提交/放弃仅在存在脏变更时出现；其余走右键
 */
import { toast } from './api.js'
import { uid } from './store.js'
import { openCtxMenu } from './ctxMenu.js'

const ROW_H = 28

export class ResultGrid {
  constructor(root, opts = {}) {
    this.root = root
    this.onSelectionChange = opts.onSelectionChange || (() => {})
    this.onCommit = opts.onCommit || (() => {})
    this.onRevert = opts.onRevert || (() => {})
    this.onExport = opts.onExport || (() => {})
    this.onImport = opts.onImport || (() => {})
    this.onGenerateSql = opts.onGenerateSql || (() => {})
    this.onRefresh = opts.onRefresh || (() => {})
    this.onExportCsv = opts.onExportCsv || null
    this.onContextMenu = opts.onContextMenu || null
    this.data = null
    this.tableRef = null
    this.editable = false
    this.readOnly = false
    this.rowIdentity = null
    this.columns = []
    this.rows = []
    this.rowState = new Map()
    this.insertedRows = []
    this.selectedRows = new Set()
    this.cellSel = null
    this._build()
    this._bind()
  }

  _build() {
    this.root.innerHTML = `
      <div class="grid-bar">
        <span class="badge" data-el="badge">—</span>
        <div class="grid-selbar" data-el="selbar" hidden></div>
        <div class="spacer"></div>
        <span class="grid-meta" data-el="status"></span>
      </div>
      <div class="grid-body" data-el="body">
        <div class="grid-head" data-el="head"></div>
        <div class="grid-viewport" data-el="viewport">
          <div class="grid-canvas" data-el="canvas"></div>
        </div>
        <input class="cell-editor" data-el="cellEditor" hidden />
      </div>
      <div class="grid-cellview" data-el="cellview" hidden></div>
    `
    this.el = {
      badge: this.root.querySelector('[data-el=badge]'),
      selbar: this.root.querySelector('[data-el=selbar]'),
      head: this.root.querySelector('[data-el=head]'),
      viewport: this.root.querySelector('[data-el=viewport]'),
      canvas: this.root.querySelector('[data-el=canvas]'),
      status: this.root.querySelector('[data-el=status]'),
      cellEditor: this.root.querySelector('[data-el=cellEditor]'),
      cellview: this.root.querySelector('[data-el=cellview]')
    }
  }

  _bind() {
    this.el.selbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sel]')
      if (!btn) return
      const k = btn.dataset.sel
      if (k === 'commit') this.onCommit()
      else if (k === 'revert') this.revertAll()
      else if (k === 'insert') this.insertRow()
      else if (k === 'more') this.openOverflowMenu(e)
    })

    this.el.viewport.addEventListener('contextmenu', (e) => {
      const rowEl = e.target.closest('[data-row]')
      const cell = e.target.closest('[data-r][data-c]')
      if (cell) {
        this.cellSel = { row: Number(cell.dataset.r), col: cell.dataset.c }
        this._renderRows()
      } else if (rowEl) {
        const idx = Number(rowEl.dataset.row)
        this.selectedRows.add(idx)
        this._renderRows()
        this.onSelectionChange(this.selectedRows)
      }
      e.preventDefault()
      if (this.onContextMenu) this.onContextMenu(e, this.cellSel)
      else this.openCellContextMenu(e)
    })

    this.el.viewport.addEventListener('scroll', () => this._renderRows())
    this.el.viewport.addEventListener('dblclick', (e) => {
      const cell = e.target.closest('[data-r][data-c]')
      if (!cell) return
      this._beginEdit(cell.dataset.r, cell.dataset.c)
    })
    this.el.viewport.addEventListener('click', (e) => {
      const rowEl = e.target.closest('[data-row]')
      if (!rowEl) return
      const idx = Number(rowEl.dataset.row)
      if (e.target.classList.contains('row-check')) {
        if (e.target.checked) this.selectedRows.add(idx)
        else this.selectedRows.delete(idx)
        this._renderRows()
        this.onSelectionChange(this.selectedRows)
        return
      }
      const cell = e.target.closest('[data-r][data-c]')
      this.cellSel = cell ? { row: Number(rowEl.dataset.row), col: cell.dataset.c } : null
      this._renderRows()
    })
    this.el.cellEditor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this._commitEdit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this._cancelEdit()
      }
    })
    this.el.cellEditor.addEventListener('blur', () => this._commitEdit())

    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'F2' && this.cellSel) {
        e.preventDefault()
        this._beginEdit(this.cellSel.row, this.cellSel.col)
      }
    })
    this.root.tabIndex = 0
  }

  _renderSelbar() {
    const bar = this.el.selbar
    if (!bar) return
    const pending = this.pendingChanges()
    const dirty = pending.length > 0
    const sel = this.selectedRows.size
    const canWrite = this.editable && !this.readOnly
    const show = sel > 0 || dirty
    bar.hidden = !show
    if (!show) {
      bar.innerHTML = ''
      return
    }
    const parts = []
    if (sel) parts.push(`<span class="muted sm">${sel} 行</span>`)
    if (dirty) parts.push(`<span class="badge warn">变更 ${pending.length}</span>`)
    if (dirty && canWrite) {
      parts.push(`<button type="button" class="btn sm primary" data-sel="commit">提交</button>`)
      parts.push(`<button type="button" class="btn sm" data-sel="revert">放弃</button>`)
    }
    if (canWrite) parts.push(`<button type="button" class="btn sm" data-sel="insert">新增</button>`)
    parts.push(
      `<button type="button" class="btn icon" data-sel="more" title="更多" aria-label="更多">⋯</button>`
    )
    bar.innerHTML = parts.join('')
  }

  openOverflowMenu(ev) {
    const canWrite = this.editable && !this.readOnly
    const items = []
    if (canWrite) {
      items.push(['dup', '复制行'], ['delete', '标记删除'], ['revert', '回滚本地'], 'sep')
    }
    items.push(
      ['copy-cell', '复制单元格'],
      ['copy-row-json', '行 JSON'],
      'sep',
      ['preview', 'SQL 预览'],
      ['gen-sql', '生成 DML'],
      ['export', '导出…'],
      ['import', '导入 CSV'],
      ['refresh', '刷新']
    )
    openCtxMenu(ev, items, (k) => {
      if (k === 'dup') this.duplicateRow()
      else if (k === 'delete') this.markDeleteSelected()
      else if (k === 'revert') this.revertAll()
      else if (k === 'copy-cell') this.copyActiveCell()
      else if (k === 'copy-row-json') this.copyRowJson()
      else if (k === 'preview') this.onGenerateSql('preview')
      else if (k === 'gen-sql') this.onGenerateSql('update')
      else if (k === 'export') this.onExport()
      else if (k === 'import') this.onImport()
      else if (k === 'refresh') this.onRefresh()
    })
  }

  openCellContextMenu(ev) {
    const canWrite = this.editable && !this.readOnly
    const dirty = this.pendingChanges().length > 0
    const items = [
      ['copy-cell', '复制单元格'],
      ['copy-row-json', '行 JSON'],
      'sep',
      ['export-csv', '导出表格'],
      ['export', '导出…'],
      ['refresh', '刷新']
    ]
    if (canWrite) {
      items.push('sep', ['edit', '编辑单元格'], ['dup', '复制行'], ['delete', '标记删除'])
      if (dirty) {
        items.push('sep', ['commit', '提交变更'], ['revert', '放弃变更'], ['dml', '生成 DML'])
      } else {
        items.push('sep', ['dml', '生成 DML'], ['import', '导入表格'])
      }
    } else {
      items.push('sep', ['dml', '生成 DML'])
    }
    openCtxMenu(ev, items, (k) => {
      if (k === 'copy-cell') this.copyActiveCell()
      else if (k === 'copy-row-json') this.copyRowJson()
      else if (k === 'export-csv') {
        if (this.onExportCsv) this.onExportCsv()
        else this.onExport()
      } else if (k === 'export') this.onExport()
      else if (k === 'refresh') this.onRefresh()
      else if (k === 'edit') {
        if (this.cellSel) this._beginEdit(this.cellSel.row, this.cellSel.col)
      } else if (k === 'dup') this.duplicateRow()
      else if (k === 'delete') this.markDeleteSelected()
      else if (k === 'commit') this.onCommit()
      else if (k === 'revert') this.revertAll()
      else if (k === 'import') this.onImport()
      else if (k === 'dml') this.onGenerateSql('update')
    })
  }

  copyActiveCell() {
    const sel = this.cellSel
    if (!sel) {
      toast('请先选中单元格', 'warn')
      return
    }
    const row = this._getRow(sel.row)
    if (!row) return
    const ci = Number(sel.col)
    const st = this._ensureState(sel.row)
    const raw = st.status === 'inserted' || st.status === 'dirty' ? st.current?.[ci] : row[ci]
    const text = raw === null || raw === undefined ? 'NULL' : String(raw)
    try {
      navigator.clipboard?.writeText(text)
    } catch {
      /* ignore */
    }
    toast('已复制单元格', 'success')
  }

  copyRowJson() {
    const sel = this.cellSel
    const idx = sel?.row ?? [...this.selectedRows][0]
    if (idx == null) {
      toast('请先选中一行', 'warn')
      return
    }
    const row = this._getRow(idx)
    if (!row) return
    const st = this._ensureState(idx)
    const values = st.status === 'inserted' || st.status === 'dirty' ? st.current : row
    const obj = {}
    this.columns.forEach((c, i) => {
      obj[this._colLabel(c)] = values?.[i] ?? null
    })
    try {
      navigator.clipboard?.writeText(JSON.stringify(obj, null, 2))
    } catch {
      /* ignore */
    }
    toast('已复制行 JSON', 'success')
  }

  discardChange(idx) {
    const st = this.rowState.get(idx)
    if (!st) return
    if (st.insert || idx >= this.rows.length) {
      this.insertedRows = this.insertedRows.filter((r) => r._idx !== idx)
      this.rowState.delete(idx)
    } else {
      st.current = st.original ? st.original.slice() : st.current
      st.status = 'clean'
      st.error = ''
    }
    this._renderRows()
    this.onRevert()
  }

  setResult({ result, tableRef, readOnly, driverUpdatable }) {
    this.data = result || null
    this.columns = result?.columns || []
    this.rows = Array.isArray(result?.rows) ? result.rows : []
    this.rowIdentity = result?.rowIdentity || null
    if (!this.rowIdentity?.keyColumns?.length && this.columns.length) {
      const pkIdx = []
      const keyColumns = []
      this.columns.forEach((c, i) => {
        if (c?.primaryKey || c?.pk) {
          keyColumns.push(this._colLabel(c))
          pkIdx.push(i)
        }
      })
      if (keyColumns.length) {
        this.rowIdentity = {
          keyColumns,
          keys: this.rows.map((row) => pkIdx.map((i) => row[i]))
        }
      }
    }
    this.tableRef = tableRef || null
    this.readOnly = !!readOnly
    this.editable =
      !readOnly &&
      !!driverUpdatable &&
      !!(this.rowIdentity?.keyColumns?.length || tableRef) &&
      !this.readOnly
    if (result?.tableRef && !this.tableRef) this.tableRef = result.tableRef
    this.rowState.clear()
    this.insertedRows = []
    this.selectedRows.clear()
    this.cellSel = null
    this._lastChangeIdxs = null
    this._renderHead()
    this._renderRows()
  }

  setTableRef(tableRef) {
    this.tableRef = tableRef
    if (tableRef && this.rowIdentity?.keyColumns?.length) this.editable = !this.readOnly
    this._renderBadge()
  }

  _renderBadge() {
    const b = this.el.badge
    if (!b) return
    if (!this.data && !this.insertedRows.length) {
      b.textContent = '—'
      b.className = 'badge'
      return
    }
    if (this.readOnly) {
      b.textContent = '只读'
      b.className = 'badge warn'
      return
    }
    if (!this.editable) {
      b.textContent = '只读'
      b.className = 'badge warn'
      return
    }
    const pending = this.pendingChanges().length
    b.textContent = pending ? `变更 ${pending}` : '可编辑'
    b.className = pending ? 'badge accent' : 'badge ok'
  }

  _colLabel(col) {
    return col?.name ?? String(col)
  }

  _gridTemplate() {
    const n = this.columns.length
    return `36px 44px repeat(${Math.max(n, 1)}, minmax(100px, 1fr)) 72px`
  }

  _renderHead() {
    const cols = this.columns
    const tpl = this._gridTemplate()
    const cells = [
      '<div class="th sel"><input type="checkbox" data-act="sel-all" /></div>',
      '<div class="th idx">#</div>'
    ]
      .concat(
        cols.map((c, i) => {
          const pk = c?.primaryKey ? '<span class="pk">PK</span>' : ''
          const type = c?.dataType ? `<span class="col-type">${escape(c.dataType)}</span>` : ''
          return `<div class="th" data-c="${i}">${escape(this._colLabel(c))}${pk}${type}</div>`
        })
      )
      .join('')
    this.el.head.innerHTML = `<div class="tr head-row" style="grid-template-columns:${tpl}">${cells}</div>`
    this.el.head.querySelector('[data-act=sel-all]')?.addEventListener('change', (e) => {
      const all = this._allRowIndices()
      if (e.target.checked) all.forEach((i) => this.selectedRows.add(i))
      else this.selectedRows.clear()
      this._renderRows()
      this.onSelectionChange(this.selectedRows)
    })
  }

  _allRowIndices() {
    return [...this.rows.keys(), ...this.insertedRows.map((r) => r._idx)]
  }

  _getRow(idx) {
    if (idx < this.rows.length) return this.rows[idx]
    return this.insertedRows.find((r) => r._idx === idx)?.values || null
  }

  _ensureState(idx) {
    if (!this.rowState.has(idx)) {
      const original = this._getRow(idx)
      this.rowState.set(idx, {
        status: 'clean',
        original,
        current: original ? original.slice() : null,
        selected: false,
        error: '',
        key: this._keyOf(idx),
        insert: idx >= this.rows.length
      })
    }
    return this.rowState.get(idx)
  }

  _keyOf(idx) {
    const ri = this.rowIdentity
    if (!ri?.keyColumns?.length) return null
    if (idx >= this.rows.length) return null
    const keyVals = ri.keys?.[idx]
    if (keyVals) {
      const key = {}
      ri.keyColumns.forEach((col, i) => {
        key[col] = keyVals[i]
      })
      return key
    }
    // 无 keys 矩阵时用列 primaryKey 从当前行取值
    const row = this.rows[idx]
    if (!row) return null
    const key = {}
    for (const name of ri.keyColumns) {
      const ci = this.columns.findIndex((c) => this._colLabel(c) === name)
      if (ci < 0) return null
      key[name] = row[ci]
    }
    return key
  }

  _renderRows() {
    const viewport = this.el.viewport
    const canvas = this.el.canvas
    const total = this.rows.length + this.insertedRows.length
    const scrollTop = viewport.scrollTop
    const h = viewport.clientHeight || 300
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5)
    const end = Math.min(total, Math.ceil((scrollTop + h) / ROW_H) + 5)
    canvas.style.height = `${total * ROW_H}px`
    canvas.style.paddingTop = `${start * ROW_H}px`

    const frag = document.createDocumentFragment()
    for (let i = start; i < end; i++) {
      const row = this._getRow(i)
      if (!row) continue
      const st = this._ensureState(i)
      const tr = document.createElement('div')
      tr.className = `tr row-${st.status}${this.selectedRows.has(i) ? ' selected' : ''}`
      tr.dataset.row = i
      tr.style.height = `${ROW_H}px`
      tr.style.gridTemplateColumns = this._gridTemplate()
      const checked = this.selectedRows.has(i) ? 'checked' : ''
      let html = `<div class="td sel"><input type="checkbox" class="row-check" ${checked} /></div><div class="td idx">${i + 1}</div>`
      this.columns.forEach((col, ci) => {
        const raw = row[ci]
        const cur = st.status === 'inserted' || st.status === 'dirty' ? st.current?.[ci] : raw
        const dirtyCell = st.status === 'dirty' && st.original?.[ci] !== st.current?.[ci]
        const isNull = cur === null || cur === undefined
        const cls = [
          'td',
          col?.primaryKey ? 'pk-cell' : '',
          isNull ? 'null-cell' : '',
          dirtyCell ? 'dirty-cell' : '',
          this.cellSel?.row === i && String(this.cellSel?.col) === String(ci) ? 'cell-active' : ''
        ]
          .filter(Boolean)
          .join(' ')
        const text = isNull ? 'NULL' : formatCell(cur)
        html += `<div class="${cls}" data-r="${i}" data-c="${ci}" title="${escape(text)}">${escape(text)}</div>`
      })
      const statusText =
        st.status === 'clean'
          ? ''
          : st.status === 'dirty'
            ? '已修改'
            : st.status === 'inserted'
              ? '新增'
              : st.status === 'deleted'
                ? '删除'
                : st.status === 'failed'
                  ? '失败'
                  : st.status
      html += `<div class="td status ${st.status}">${statusText}${
        st.error ? `<span class="err" title="${escape(st.error)}">!</span>` : ''
      }</div>`
      tr.innerHTML = html
      frag.appendChild(tr)
    }
    canvas.replaceChildren(frag)
    this._renderStatus()
    this._renderBadge()
    this._renderSelbar()
  }

  _renderStatus() {
    const data = this.data
    const parts = []
    if (data) {
      parts.push(`${this.rows.length} 行`)
      if (data.affectedRows != null) parts.push(`影响 ${data.affectedRows}`)
      if (data.durationMs != null) parts.push(`${data.durationMs} ms`)
      if (data.truncated) parts.push('已截断')
    }
    const pending = this.pendingChanges()
    if (pending.length) parts.push(`变更 ${pending.length}`)
    if (this.tableRef) {
      parts.push(
        `表 ${[this.tableRef.database, this.tableRef.schema, this.tableRef.table].filter(Boolean).join('.')}`
      )
    }
    this.el.status.textContent = parts.join(' · ')
  }

  _beginEdit(rowIdx, colIdx) {
    if (this.readOnly || !this.editable) {
      toast(this.readOnly ? '连接只读' : '结果集不可编辑', 'warn')
      return
    }
    const st = this._ensureState(rowIdx)
    if (st.status === 'deleted') return
    const cell = this.el.viewport.querySelector(`[data-r="${rowIdx}"][data-c="${colIdx}"]`)
    if (!cell) return
    const ci = Number(colIdx)
    const val = st.current?.[ci]
    const ed = this.el.cellEditor
    ed.hidden = false
    ed.value = val === null || val === undefined ? '' : String(val)
    ed.dataset.r = rowIdx
    ed.dataset.c = ci
    ed.style.left = cell.offsetLeft + 'px'
    ed.style.top = cell.offsetTop + 'px'
    ed.style.width = Math.max(80, cell.offsetWidth) + 'px'
    ed.style.height = cell.offsetHeight + 'px'
    this.el.canvas.appendChild(ed)
    ed.focus()
    ed.select()
    this._editOriginalNull = val === null || val === undefined
  }

  _commitEdit() {
    const ed = this.el.cellEditor
    if (ed.hidden) return
    const rowIdx = Number(ed.dataset.r)
    const ci = Number(ed.dataset.c)
    const col = this.columns[ci]
    let value = ed.value
    if (value === '' && this._editOriginalNull) value = null
    else if (col?.dataType && /int|number|decimal|double|float|bigint/i.test(col.dataType)) {
      if (value !== null && value !== '') {
        const n = Number(value)
        value = Number.isNaN(n) ? value : n
      }
    } else if (col?.dataType && /bool/i.test(col.dataType)) {
      if (value === 'true' || value === 'TRUE' || value === '1') value = true
      else if (value === 'false' || value === 'FALSE' || value === '0') value = false
    }
    this._applyCell(rowIdx, ci, value)
    ed.hidden = true
    this._renderRows()
  }

  _cancelEdit() {
    this.el.cellEditor.hidden = true
  }

  _applyCell(rowIdx, ci, value) {
    const st = this._ensureState(rowIdx)
    if (!st.current) st.current = st.original ? st.original.slice() : this.columns.map(() => null)
    const prev = st.current[ci]
    if (prev === value) return
    st.current[ci] = value
    if (st.insert) st.status = 'inserted'
    else if (st.original?.[ci] === value) {
      const dirty = st.current.some((v, i) => v !== st.original[i])
      st.status = dirty ? 'dirty' : 'clean'
    } else st.status = 'dirty'
  }

  insertRow(fromIdx) {
    if (this.readOnly || !this.editable) {
      toast('当前结果集不可写', 'warn')
      return
    }
    const cols = this.columns
    let values = cols.map(() => null)
    if (fromIdx != null) {
      const src = this._getRow(fromIdx)
      if (src) values = src.slice()
    }
    const idx = this.rows.length + this.insertedRows.length
    this.insertedRows.push({ _idx: idx, values })
    this._ensureState(idx)
    const st = this.rowState.get(idx)
    st.status = 'inserted'
    st.current = values
    st.insert = true
    this.el.viewport.scrollTop = this.el.viewport.scrollHeight
    this._renderRows()
  }

  duplicateRow() {
    const idx = this.cellSel?.row ?? [...this.selectedRows][0]
    if (idx == null) {
      toast('请先选中一行', 'warn')
      return
    }
    this.insertRow(idx)
  }

  markDeleteSelected() {
    const indices = new Set(this.selectedRows)
    if (this.cellSel) indices.add(this.cellSel.row)
    if (!indices.size) {
      toast('请先选中要删除的行', 'warn')
      return
    }
    if (!this.rowIdentity?.keyColumns?.length && !this.tableRef) {
      toast('无主键，无法生成 DELETE', 'error')
      return
    }
    for (const i of indices) {
      const st = this._ensureState(i)
      if (st.insert) {
        this.insertedRows = this.insertedRows.filter((r) => r._idx !== i)
        this.rowState.delete(i)
        continue
      }
      if (st.status === 'deleted') st.status = 'clean'
      else st.status = 'deleted'
    }
    this.selectedRows.clear()
    this._renderRows()
  }

  revertAll() {
    this.rowState.clear()
    this.insertedRows = []
    this.selectedRows.clear()
    this.cellSel = null
    this._renderRows()
    toast('已放弃本地变更', 'info')
    this.onRevert()
  }

  pendingChanges() {
    const out = []
    for (const [idx, st] of this.rowState) {
      if (st.status === 'clean') continue
      if (!st.status) continue
      out.push({ idx, ...st })
    }
    return out
  }

  toRowChanges() {
    const table = this._tableRefForChange()
    if (!table) return []
    const cols = this.columns.map((c) => this._colLabel(c))
    const changes = []
    for (const [idx, st] of this.rowState) {
      const kind =
        st.status === 'failed'
          ? st.failType || (st.insert ? 'inserted' : 'dirty')
          : st.status
      if (kind === 'clean') continue
      if (kind === 'dirty') {
        const set = {}
        const original = {}
        cols.forEach((name, i) => {
          original[name] = st.original?.[i]
          if (st.current?.[i] !== st.original?.[i]) set[name] = st.current?.[i]
        })
        if (!Object.keys(set).length) continue
        const key = st.key || this._keyOf(idx)
        if (!key) {
          toast('无主键，无法提交修改', 'error')
          continue
        }
        changes.push({ type: 'update', table, key, set, original, _idx: idx })
      } else if (kind === 'inserted') {
        const values = {}
        cols.forEach((name, i) => {
          const v = st.current?.[i]
          if (v !== null && v !== undefined) values[name] = v
        })
        changes.push({ type: 'insert', table, values, _idx: idx })
      } else if (kind === 'deleted') {
        const key = st.key || this._keyOf(idx)
        if (!key) {
          toast('无主键，无法提交删除', 'error')
          continue
        }
        changes.push({ type: 'delete', table, key, _idx: idx })
      }
    }
    this._lastChangeIdxs = changes.map((c) => c._idx)
    return changes
  }

  _tableRefForChange() {
    if (this.tableRef) return this.tableRef
    if (this.data?.tableRef) return this.data.tableRef
    return null
  }

  /**
   * @param batchResult 宿主 BatchResult
   * @param changes 本次提交的 RowChange[]（含 _idx），用于 index → 本地行映射
   */
  applyBatchResult(batchResult, changes) {
    const results = batchResult?.results || []
    const list = Array.isArray(changes) && changes.length ? changes : this.toRowChanges()
    let anyFail = false
    const touched = new Set()
    results.forEach((r) => {
      const idxInBatch = typeof r?.index === 'number' ? r.index : results.indexOf(r)
      const src = list[idxInBatch]
      const localIdx = src?._idx ?? this._lastChangeIdxs?.[idxInBatch]
      if (localIdx == null) return
      const st = this.rowState.get(localIdx)
      if (!st) return
      touched.add(localIdx)
      if (r.ok) {
        if (st.insert || st.status === 'inserted') {
          this.insertedRows = this.insertedRows.filter((x) => x._idx !== localIdx)
          this.rowState.delete(localIdx)
        } else {
          st.original = st.current ? st.current.slice() : st.original
          st.status = 'clean'
          st.error = ''
          st.key = st.key || this._keyOf(localIdx)
        }
      } else {
        st.failType = st.insert ? 'inserted' : st.status === 'deleted' ? 'deleted' : st.status === 'inserted' ? 'inserted' : 'dirty'
        if (st.failType === 'clean' || !st.failType) st.failType = 'dirty'
        st.status = 'failed'
        st.error = r.error || '提交失败'
        anyFail = true
      }
    })
    this._renderRows()
    return { anyFail, results }
  }

  sqlPreview(changes) {
    const table = this._tableRefForChange()
    if (!table) return '-- 缺少表引用'
    const t = quoteIdent([table.database, table.schema, table.table].filter(Boolean).join('.'))
    return (changes || this.toRowChanges())
      .map((c) => {
        if (c.type === 'update') {
          const sets = Object.entries(c.set)
            .map(([k, v]) => `${quoteIdent(k)} = ${sqlLiteral(v)}`)
            .join(', ')
          const wh = Object.entries(c.key)
            .map(([k, v]) => `${quoteIdent(k)} = ${sqlLiteral(v)}`)
            .join(' AND ')
          return `UPDATE ${t} SET ${sets} WHERE ${wh};`
        }
        if (c.type === 'insert') {
          const keys = Object.keys(c.values)
          return `INSERT INTO ${t} (${keys.map(quoteIdent).join(', ')}) VALUES (${keys
            .map((k) => sqlLiteral(c.values[k]))
            .join(', ')});`
        }
        if (c.type === 'delete') {
          const wh = Object.entries(c.key)
            .map(([k, v]) => `${quoteIdent(k)} = ${sqlLiteral(v)}`)
            .join(' AND ')
          return `DELETE FROM ${t} WHERE ${wh};`
        }
        return `-- ${c.type}`
      })
      .join('\n')
  }

  getExportData(scope = 'all') {
    const cols = this.columns.map((c) => this._colLabel(c))
    let rows
    if (scope === 'selected' && this.selectedRows.size) {
      rows = [...this.selectedRows].map((i) => this._getRow(i)).filter(Boolean)
    } else {
      rows = this.rows.map((r) => r)
      rows = rows.concat(this.insertedRows.map((r) => r.values))
    }
    return { cols, rows }
  }
}

function formatCell(v) {
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function quoteIdent(name) {
  if (!name) return ''
  return '`' + String(name).replace(/`/g, '``') + '`'
}

export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return `'${String(v).replace(/'/g, "''")}'`
}

export { ROW_H, uid }
