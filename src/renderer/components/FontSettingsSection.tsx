/**
 * FontSettingsSection — 设置页「字体」整块
 * 结构：字号四档 → 英文字体槽 → 中文字体槽 → 自定义上传列表。
 * 中英双槽：有英文栈时 --font = en + cjk（Latin 优先）；无英文栈时行为与旧版一致。
 * 供 SettingsPage 外观标签挂载；内部读 useFont / useI18n，无需透传 props。
 * 依赖：useFont、useI18n、toastStore。
 */
import { useCallback, useEffect, useRef } from 'react'
import {
  useFont,
  FONT_PRESETS_EN,
  FONT_PRESETS_CJK,
  MAX_FONT_BYTES,
} from '@renderer/hooks/useFont'
import { FONT_SIZE_SCALES } from '@shared/types/plugin'
import { useI18n } from '@renderer/hooks/useI18n'
import { toastStore } from '@renderer/hooks/useToast'

/** 预览样例：中英数混排，便于观察字形 */
const PREVIEW_TEXT = '永 Aa 字体'

/** 字号档展示（短硬编码，i18n 无对应 key） */
const SIZE_OPTIONS: { value: number; label: string }[] = FONT_SIZE_SCALES.map((s) => ({
  value: s,
  label: `${Math.round(s * 100)}%`,
}))

export function FontSettingsSection() {
  const {
    enPresetId,
    cjkPresetId,
    customFontId,
    customFonts,
    fontSizeScale,
    uploading,
    hydrate,
    setEnPreset,
    setCjkPreset,
    setFontSizeScale,
    applyCustom,
    uploadFont,
    removeCustomFont,
  } = useFont()
  const { t } = useI18n()
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  const handlePickFile = useCallback(() => {
    fileRef.current?.click()
  }, [])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      // 允许重复选择同一文件
      e.target.value = ''
      if (!file) return
      if (file.size > MAX_FONT_BYTES) {
        toastStore.getState().push(t('settings.font.tooLarge'), 'error')
        return
      }
      void uploadFont(file)
    },
    [uploadFont, t],
  )

  const handleRemove = useCallback(
    (id: string) => {
      void removeCustomFont(id)
    },
    [removeCustomFont],
  )

  return (
    <div className="s-card font-settings">
      <h2>{t('settings.font.title')}</h2>
      <p className="hint">{t('settings.font.hint')}</p>

      {/* 字号档：与 --shell-scale 独立，写 --font-size-base */}
      <div className="field" style={{ borderTop: 'none', paddingBottom: 8 }}>
        <div>
          <div className="label">字号</div>
          <p className="desc">调整正文与界面文字大小，即时生效</p>
        </div>
        <div className="segmented font-size-seg" role="group" aria-label="字号">
          {SIZE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={fontSizeScale === opt.value ? 'active' : ''}
              onClick={() => void setFontSizeScale(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* 英文字体槽（可选；空 = 默认，不单独指定） */}
      <div className="field">
        <div>
          <div className="label">英文字体</div>
          <p className="desc">Latin 字符优先使用；「默认」时不单独指定</p>
        </div>
      </div>
      <div className="font-slot-row" role="listbox" aria-label="英文字体">
        <button
          type="button"
          role="option"
          aria-selected={!enPresetId}
          className={`font-slot-chip${!enPresetId ? ' active' : ''}`}
          onClick={() => void setEnPreset(null)}
        >
          默认
        </button>
        {FONT_PRESETS_EN.map((preset) => {
          const active = enPresetId === preset.id
          return (
            <button
              key={preset.id}
              type="button"
              role="option"
              aria-selected={active}
              className={`font-slot-chip${active ? ' active' : ''}`}
              onClick={() => void setEnPreset(preset.id)}
            >
              <span className="font-slot-preview" style={{ fontFamily: preset.previewFamily }}>
                Aa
              </span>
              {preset.label}
            </button>
          )
        })}
      </div>

      {/* 中文字体槽 */}
      <div className="field">
        <div>
          <div className="label">中文字体</div>
          <p className="desc">{t('settings.font.presetsDesc')}</p>
        </div>
      </div>
      <div className="font-slot-row" role="listbox" aria-label="中文字体">
        <button
          type="button"
          role="option"
          aria-selected={!cjkPresetId && !customFontId}
          className={`font-slot-chip${!cjkPresetId && !customFontId ? ' active' : ''}`}
          onClick={() => void setCjkPreset(null)}
        >
          默认
        </button>
        {FONT_PRESETS_CJK.map((preset) => {
          const active = cjkPresetId === preset.id && !customFontId
          return (
            <button
              key={preset.id}
              type="button"
              role="option"
              aria-selected={active}
              className={`font-slot-chip${active ? ' active' : ''}`}
              onClick={() => void setCjkPreset(preset.id)}
            >
              <span className="font-slot-preview" style={{ fontFamily: preset.previewFamily }}>
                永
              </span>
              {preset.label}
            </button>
          )
        })}
      </div>

      <div className="field">
        <div>
          <div className="label">{t('settings.font.customLabel')}</div>
          <p className="desc">{t('settings.font.uploadHint')}</p>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          onClick={handlePickFile}
          disabled={uploading}
        >
          {uploading ? t('settings.font.uploading') : t('settings.font.upload')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
          className="font-file-input"
          onChange={handleFileChange}
        />
      </div>

      {customFonts.length === 0 ? (
        <p className="font-empty">{t('settings.font.emptyCustom')}</p>
      ) : (
        <ul className="font-custom-list">
          {customFonts.map((meta) => {
            const active = customFontId === meta.id
            return (
              <li key={meta.id} className={`font-custom-item${active ? ' active' : ''}`}>
                <button
                  type="button"
                  className="font-custom-main"
                  onClick={() => void applyCustom(meta.id)}
                >
                  <span className="font-preview sm" style={{ fontFamily: `"${meta.family}", sans-serif` }}>
                    {PREVIEW_TEXT}
                  </span>
                  <span className="font-custom-meta">
                    <strong>{meta.name}</strong>
                    <small>{meta.fileName}</small>
                  </span>
                  {active ? <em className="font-badge">{t('settings.font.active')}</em> : null}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm font-remove"
                  onClick={() => handleRemove(meta.id)}
                  aria-label={t('settings.font.remove')}
                >
                  {t('settings.font.remove')}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
