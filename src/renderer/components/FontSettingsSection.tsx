/**
 * FontSettingsSection — 设置页「字体」整块（预设卡片 + 已上传列表 + 上传按钮）
 * 供 SettingsPage 外观标签挂载；内部读 useFont / useI18n，无需透传 props。
 * 依赖：useFont、useI18n、toastStore。
 */
import { useCallback, useEffect, useRef } from 'react'
import { useFont, FONT_PRESETS, MAX_FONT_BYTES } from '@renderer/hooks/useFont'
import { useI18n } from '@renderer/hooks/useI18n'
import { toastStore } from '@renderer/hooks/useToast'

/** 预览样例：中英数混排，便于观察字形 */
const PREVIEW_TEXT = '永 Aa 字体'

export function FontSettingsSection() {
  const {
    presetId,
    customFontId,
    customFonts,
    uploading,
    hydrate,
    setPreset,
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

      <div className="field" style={{ borderTop: 'none', paddingBottom: 8 }}>
        <div>
          <div className="label">{t('settings.font.presetsLabel')}</div>
          <p className="desc">{t('settings.font.presetsDesc')}</p>
        </div>
      </div>

      <div className="font-grid" role="listbox" aria-label={t('settings.font.presetsLabel')}>
        {FONT_PRESETS.map((preset) => {
          const active = presetId === preset.id && !customFontId
          return (
            <button
              key={preset.id}
              type="button"
              role="option"
              aria-selected={active}
              className={`font-card${active ? ' active' : ''}`}
              onClick={() => void setPreset(preset.id)}
            >
              <span className="font-preview" style={{ fontFamily: preset.previewFamily }}>
                {PREVIEW_TEXT}
              </span>
              <strong>{t(preset.nameKey)}</strong>
              {active ? <em className="font-badge">{t('settings.font.active')}</em> : null}
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
