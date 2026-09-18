/**
 * importExport.js — 结果导出 CSV/JSON/SQL/Markdown + CSV 导入向导（DB-G）
 */
import { saveTextFile, clipboardWrite, toast, DbHost } from './api.js'
import { escape, sqlLiteral, quoteIdent } from './resultGrid.js'

export function toCsv(cols, rows, { bom = true, delimiter = ',' } = {}) {
  const esc = (v) => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    if (s.includes(delimiter) || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"'
    }
    return s
  }
  const lines = [cols.map(esc).join(delimiter)]
  for (const r of rows) lines.push(r.map(esc).join(delimiter))
  return (bom ? '\uFEFF' : '') + lines.join('\n')
}

export function toJson(cols, rows, { nullAsNull = true } = {}) {
  const arr = rows.map((r) => {
    const o = {}
    cols.forEach((c, i) => {
      let v = r[i]
      if (v === undefined) v = null
      if (!nullAsNull && v === null) v = ''
      o[c] = v
    })
    return o
  })
  return JSON.stringify(arr, null, 2)
}

export function toSql(cols, rows, tableRef, { transaction = true, batchSize = 100 } = {}) {
  const parts = [tableRef?.database, tableRef?.schema, tableRef?.table].filter(Boolean)
  const t = parts.length ? parts.map((p) => quoteIdent(p)).join('.') : quoteIdent('exported_table')
  const lines = []
  if (transaction) lines.push('BEGIN;')
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize)
    const values = chunk
      .map((r) => `(${r.map((v) => sqlLiteral(v)).join(', ')})`)
      .join(',\n  ')
    lines.push(`INSERT INTO ${t} (${cols.map(quoteIdent).join(', ')}) VALUES\n  ${values};`)
  }
  if (transaction) lines.push('COMMIT;')
  return lines.join('\n')
}

export function toMarkdown(cols, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return 'NULL'
    return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')
  }
  const head = `| ${cols.map(cell).join(' | ')} |`
  const sep = `| ${cols.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n')
  return [head, sep, body].join('\n')
}

export function toTsv(cols, rows) {
  return toCsv(cols, rows, { bom: false, delimiter: '\t' })
}

export function buildExport(format, cols, rows, tableRef, uiPrefs = {}) {
  switch (format) {
    case 'csv':
      return { filename: `result-${Date.now()}.csv`, content: toCsv(cols, rows, { bom: uiPrefs.exportBom !== false }) }
    case 'json':
      return { filename: `result-${Date.now()}.json`, content: toJson(cols, rows) }
    case 'sql':
      return { filename: `result-${Date.now()}.sql`, content: toSql(cols, rows, tableRef) }
    case 'md':
    case 'markdown':
      return { filename: `result-${Date.now()}.md`, content: toMarkdown(cols, rows) }
    case 'tsv':
      return { filename: `result-${Date.now()}.tsv`, content: toTsv(cols, rows) }
    default:
      return { filename: 'result.txt', content: toCsv(cols, rows) }
  }
}

export async function exportResult(format, cols, rows, tableRef, uiPrefs) {
  if (!cols?.length && !rows?.length) {
    await toast('没有可导出的数据', 'warn')
    return { ok: false }
  }
  const { filename, content } = buildExport(format, cols, rows, tableRef, uiPrefs)
  if (format === 'tsv') {
    await clipboardWrite(content)
    await toast('已复制 TSV', 'success')
    return { ok: true, via: 'clipboard' }
  }
  return saveTextFile(filename, content)
}

export async function copyResult(format, cols, rows) {
  if (!cols?.length && !rows?.length) {
    await toast('没有可复制的数据', 'warn')
    return
  }
  let text
  if (format === 'tsv') text = toTsv(cols, rows)
  else if (format === 'json') text = toJson(cols, rows)
  else if (format === 'sql') text = toSql(cols, rows, null)
  else if (format === 'md') text = toMarkdown(cols, rows)
  else text = toCsv(cols, rows, { bom: false })
  await clipboardWrite(text)
  await toast(`已复制 ${format.toUpperCase()}`, 'success')
}

/** 解析 CSV 文本（最小可用：引号/换行） */
export function parseCsv(text, { delimiter = ',', hasHeader = true } = {}) {
  const rows = []
  let row = []
  let field = ''
  let inQ = false
  const s = String(text || '').replace(/^\uFEFF/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else field += ch
      continue
    }
    if (ch === '"') {
      inQ = true
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      continue
    }
    field += ch
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  let header
  if (hasHeader) {
    header = rows.shift() || []
  } else {
    header = (rows[0] || []).map((_, i) => `col${i + 1}`)
  }
  return { header, rows: rows.filter((r) => r.some((c) => c !== '')) }
}

/** CSV 导入向导（G2.1 最小：粘贴 / 选文件 → 预览 → 执行） */
export function createImportWizard(root, ctx = {}) {
  const prefillTable = ctx.defaultTable || ''
  root.innerHTML = `
    <div class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <strong>CSV 导入</strong>
          <button type="button" class="btn ghost" data-act="close">关闭</button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>目标表</label>
            <input data-el="table" placeholder="schema.table" value="${escape(prefillTable)}" />
          </div>
          <div class="form-row">
            <label>分隔符</label>
            <select data-el="delim">
              <option value=",">逗号 ,</option>
              <option value=";">分号 ;</option>
              <option value="\\t">制表符 Tab</option>
            </select>
            <label class="check"><input type="checkbox" data-el="hasHeader" checked /> 首行是表头</label>
            <label class="check"><input type="checkbox" data-el="upsert" /> Upsert</label>
          </div>
          <div class="form-row">
            <label>CSV 文本 / 预览</label>
            <div class="row">
              <button type="button" class="btn" data-act="pick-csv" title="选择 CSV 文件">选择文件…</button>
              <span class="muted sm" data-el="fileName"></span>
            </div>
            <textarea data-el="csv" rows="8" placeholder="粘贴 CSV 或选择文件"></textarea>
            <input type="hidden" data-el="filePath" value="" />
          </div>
          <div class="form-row">
            <button type="button" class="btn" data-act="preview">预览</button>
            <button type="button" class="btn primary" data-act="run">执行导入</button>
            <span class="hint" data-el="hint"></span>
          </div>
          <pre class="preview" data-el="preview"></pre>
        </div>
      </div>
    </div>
  `
  const $ = (n) => root.querySelector(`[data-el=${n}]`)
  const hint = $('hint')
  const close = () => {
    root.innerHTML = ''
  }
  root.querySelector('[data-act=close]')?.addEventListener('click', close)

  const readDelim = () => ($('delim').value === '\\t' ? '\t' : $('delim').value)

  root.querySelector('[data-act=pick-csv]')?.addEventListener('click', async () => {
    try {
      const picked = await DbHost.pickImportFile()
      const path =
        typeof picked === 'string'
          ? picked
          : picked?.path || picked?.filePath || ''
      if (!path) {
        hint.textContent = '未选择文件'
        return
      }
      $('filePath').value = path
      $('fileName').textContent = path.split(/[\\/]/).pop() || path
      hint.textContent = '文件已选'
    } catch (e) {
      hint.textContent = String(e.message || e).slice(0, 80)
    }
  })

  root.querySelector('[data-act=preview]')?.addEventListener('click', async () => {
    try {
      const text = $('csv').value
      const filePath = $('filePath').value.trim()
      const delim = readDelim()
      const tableName = $('table').value.trim()
      const hasHeader = $('hasHeader').checked
      if (!text && !filePath) {
        hint.textContent = '请粘贴 CSV 或选择文件'
        return
      }
      if (text) {
        const parsed = parseCsv(text, { delimiter: delim, hasHeader })
        const sample = parsed.rows.slice(0, 20)
        $('preview').textContent =
          parsed.header.join(' | ') + '\n' + sample.map((r) => r.join(' | ')).join('\n')
        hint.textContent = `${parsed.rows.length} 行 · ${parsed.header.length} 列`
      }
      if (!tableName) {
        hint.textContent = (hint.textContent ? hint.textContent + ' · ' : '') + '请填写目标表'
        return
      }
      if (ctx.sessionKey && ctx.hostReady) {
        try {
          const payload = {
            sessionKey: ctx.sessionKey,
            table: parseTableRef(tableName),
            options: { delimiter: delim, hasHeader, sampleRows: 20 }
          }
          if (text) payload.csvText = text
          else if (filePath) payload.filePath = filePath
          const res = await DbHost.importPreview(payload)
          if (res) {
            const lines = []
            if (res.columns?.length) lines.push(res.columns.join(' | '))
            if (res.sampleRows?.length) {
              lines.push(...res.sampleRows.slice(0, 8).map((r) => (r || []).join(' | ')))
            }
            if (res.sqlPreview?.length) lines.push('', ...res.sqlPreview.slice(0, 3))
            if (lines.length) {
              $('preview').textContent =
                ($('preview').textContent ? $('preview').textContent + '\n\n' : '') + lines.join('\n')
            }
            hint.textContent = `${res.totalRowsEstimate ?? '?'} 行 · 预览就绪`
          }
        } catch (e) {
          hint.textContent += ` · ${String(e.message || e).slice(0, 80)}`
        }
      }
    } catch (e) {
      toast(String(e.message || e).slice(0, 120), 'error')
    }
  })

  root.querySelector('[data-act=run]')?.addEventListener('click', async () => {
    const tableName = $('table').value.trim()
    if (!tableName) {
      toast('请填写目标表', 'warn')
      return
    }
    const text = $('csv').value
    const filePath = $('filePath').value.trim()
    if (!text && !filePath) {
      toast('请粘贴 CSV 或选择文件', 'warn')
      return
    }
    const delim = readDelim()
    const options = {
      delimiter: delim,
      hasHeader: $('hasHeader').checked,
      conflict: $('upsert').checked ? 'upsert' : 'insert'
    }
    try {
      if (!ctx.sessionKey) {
        toast('请先连接数据库', 'warn')
        return
      }
      const payload = {
        sessionKey: ctx.sessionKey,
        table: parseTableRef(tableName),
        options,
        confirmed: true
      }
      if (text) payload.csvText = text
      else payload.filePath = filePath
      const res = await DbHost.importRun(payload)
      const failed = res?.failed || 0
      toast(
        res
          ? `导入完成 · 成功 ${res.inserted ?? 0}${failed ? ` · 失败 ${failed}` : ''}`
          : '导入完成',
        failed ? 'warn' : 'success'
      )
      if (failed && res?.errors?.length) {
        $('preview').textContent = res.errors.slice(0, 5).join('\n')
        return
      }
      close()
    } catch (e) {
      const msg = String(e.message || e)
      const lag = /尚未就绪|功能未就绪|unknown method|permission denied/i.test(msg)
      toast(lag ? '导入暂不可用' : msg.slice(0, 120), lag ? 'warn' : 'error')
      // 本地预览兜底（粘贴文本时）
      if (text) {
        const parsed = parseCsv(text, { delimiter: delim, hasHeader: options.hasHeader })
        $('preview').textContent =
          '（仅本地预览）\n' +
          toSql(parsed.header, parsed.rows, parseTableRef(tableName)).slice(0, 4000)
      }
    }
  })

  return { close, open: () => {} }
}

export function parseTableRef(name) {
  const parts = String(name).split('.').filter(Boolean)
  if (parts.length === 3) return { database: parts[0], schema: parts[1], table: parts[2] }
  if (parts.length === 2) return { schema: parts[0], table: parts[1] }
  return { table: parts[0] || name }
}

export async function exportConnections(connections) {
  if (!connections?.length) {
    await toast('没有可导出的连接', 'warn')
    return { ok: false }
  }
  const safe = connections.map((c) => {
    const { secretRef, ...rest } = c
    void secretRef
    return { ...rest, secretRef: c.secretRef ? '(preserved)' : undefined }
  })
  return saveTextFile(
    `db-connections-${Date.now()}.json`,
    JSON.stringify(safe, null, 2),
    { successMsg: '连接配置已导出' }
  )
}

export async function exportSessions(sessions) {
  if (!sessions?.length) {
    await toast('没有可导出的会话', 'warn')
    return { ok: false }
  }
  return saveTextFile(`db-sessions-${Date.now()}.json`, JSON.stringify(sessions || [], null, 2), {
    successMsg: '会话已导出'
  })
}

export async function exportHistory(history) {
  if (!history?.length) {
    await toast('没有可导出的历史', 'warn')
    return { ok: false }
  }
  const cols = ['ts', 'connectionId', 'sessionName', 'durationMs', 'rowCount', 'error', 'sql']
  const rows = (history || []).map((h) => [
    new Date(h.ts).toISOString(),
    h.connectionId || '',
    h.sessionName || '',
    h.durationMs ?? '',
    h.rowCount ?? '',
    h.error || '',
    h.sql || ''
  ])
  return saveTextFile(`db-history-${Date.now()}.csv`, toCsv(cols, rows), { successMsg: '历史已导出' })
}

export { escape }
