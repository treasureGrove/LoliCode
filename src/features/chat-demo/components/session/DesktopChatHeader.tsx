import clsx from 'clsx'
import { useContext, useEffect, useState } from 'react'
import { WindowControlsContext } from '@/app/shell/AppPageHeader'
import { tavernApi } from '@/lib/api/tavern'
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE } from '@/lib/platform'
import type { AgentModel } from '@/types/agent'
import { useTranslate } from '../../i18n/index.js'
import {
  setModelSource,
  triggerOpenChannels,
  useSettings,
  type ModelSource,
} from '../../services/settings.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './DesktopChatHeader.module.css'

export const DesktopChatHeader = ({
  title,
  siderCollapsed = false,
}: {
  title?: string
  siderCollapsed?: boolean
}) => {
  const t = useTranslate()
  const windowControls = useContext(WindowControlsContext)
  const modelSource = useSettings((state) => state.modelSource)
  const apiKey = useSettings((state) => state.apiKey)
  const [channelModels, setChannelModels] = useState<AgentModel[]>([])

  useEffect(() => {
    let cancelled = false
    tavernApi
      .getCatalog()
      .then((catalog) => {
        if (cancelled || !catalog?.models) return
        setChannelModels(catalog.models)
        const current = useSettings.getState()
        // 若尚未填写官方 API Key 且存在桌面端渠道/本地模型，自动优先选用
        if (
          !current.apiKey &&
          !current.modelSource.startsWith('channel:') &&
          catalog.models.length > 0
        ) {
          const preferred = catalog.defaultModel || catalog.models[0].id
          setModelSource(`channel:${preferred}`)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const isLocalModel = modelSource.startsWith('channel:tavern-local:')
  const isChannelModel = modelSource.startsWith('channel:') && !isLocalModel
  const selectedChannelModel = isChannelModel
    ? channelModels.find((m) => `channel:${m.id}` === modelSource)
    : undefined
  const isFreeChannel = Boolean(selectedChannelModel?.isFree)

  return (
    <header
      className={styles.header}
      {...DRAG_REGION_ATTR}
      style={DRAG_REGION_STYLE as React.CSSProperties}
    >
      <div className={styles.left}>
        <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
          {title || t('appName')}
        </div>
        <span
          className={clsx(
            styles.quotaBadge,
            isLocalModel || isFreeChannel
              ? styles.quotaFree
              : isChannelModel
                ? styles.quotaChannel
                : styles.quotaKey
          )}
          title={
            isLocalModel
              ? '当前使用本机离线模型推理，完全免费，不消耗任何 API 额度'
              : isFreeChannel
                ? '当前使用免费公共渠道模型，不消耗你的个人 API 额度'
                : isChannelModel
                  ? '当前复用桌面端「渠道与模型」配置，按所选渠道计费'
                  : '当前直连 DeepSeek 官方 API，消耗你在设置中填写的 API Key 余额'
          }
        >
          {isLocalModel
            ? '本地模型 · 0 额度消耗'
            : isFreeChannel
              ? '免费渠道 · 0 额度消耗'
              : isChannelModel
                ? '共享渠道 · 复用桌面配置'
                : apiKey
                  ? '官方 API · 消耗 Key 余额'
                  : '官方 API · 待填 Key'}
        </span>
      </div>
      <div
        className={styles.controls}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <select
          aria-label="选择对话模型来源"
          className={styles.modelSelect}
          value={modelSource}
          onChange={(event) => setModelSource(event.target.value as ModelSource)}
        >
          {channelModels.length > 0 && (
            <optgroup label="桌面端渠道与本地离线模型">
              {channelModels.map((model) => {
                const value: ModelSource = `channel:${model.id}`
                const local = model.id.startsWith('tavern-local:')
                return (
                  <option key={value} value={value}>
                    {local
                      ? `${model.name} (本地离线 · 不消耗额度)`
                      : `${model.channelName} · ${model.name}${model.isFree ? ' (免费)' : ''}`}
                  </option>
                )
              })}
            </optgroup>
          )}
          <optgroup label="DeepSeek 官方直连 (需 API Key)">
            <option value="deepseek-flash">deepseek-flash (官方直连 · 支持联网/语音)</option>
            <option value="deepseek-v4-pro">deepseek-v4-pro (官方直连 · 旗舰推理)</option>
          </optgroup>
        </select>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={() => triggerOpenChannels()}
        >
          渠道与模型
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={() => openSettings('data')}
        >
          API Key / 备份
        </button>
        {windowControls ? <div className={styles.windowControls}>{windowControls}</div> : null}
      </div>
    </header>
  )
}
