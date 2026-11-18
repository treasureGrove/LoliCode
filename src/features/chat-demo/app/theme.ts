import { useSyncExternalStore } from 'react'
import { useSettings, type ThemePreference } from '../services/settings.js'

export type Theme = 'light' | 'dark'

const query =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

const subscribeOsTheme = (listener: () => void) => {
  query?.addEventListener('change', listener)
  const observer =
    typeof MutationObserver !== 'undefined' && typeof document !== 'undefined'
      ? new MutationObserver(listener)
      : null
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme'],
  })
  return () => {
    query?.removeEventListener('change', listener)
    observer?.disconnect()
  }
}

const getOsTheme = (): Theme => {
  if (typeof document !== 'undefined') {
    if (
      document.documentElement.classList.contains('dark') ||
      document.documentElement.getAttribute('data-theme') === 'dark'
    ) {
      return 'dark'
    }
    if (
      document.documentElement.classList.contains('light') ||
      document.documentElement.getAttribute('data-theme') === 'light'
    ) {
      return 'light'
    }
  }
  return query?.matches ? 'dark' : 'light'
}

const resolveTheme = (preference: ThemePreference, osTheme: Theme): Theme =>
  preference === 'system' ? osTheme : preference

/** 当前实际生效的深浅色：手动选择优先，「跟随系统」时取宿主或系统设置 */
export const useTheme = (): Theme => {
  const preference = useSettings((state) => state.themePreference)
  const osTheme = useSyncExternalStore(subscribeOsTheme, getOsTheme, (): Theme => 'light')
  return resolveTheme(preference, osTheme)
}

/** 同步 data-ds-dark-theme 供 CSS 变量与弹窗使用，不污染宿主全局样式。 */
const applyTheme = (theme: Theme) => {
  if (typeof document === 'undefined') return
  const body = document.body
  if (theme === 'dark') {
    body.setAttribute('data-ds-dark-theme', 'dark')
  } else {
    body.removeAttribute('data-ds-dark-theme')
  }
}

let appliedTheme: Theme | null = null
let themeInitialized = false

const syncTheme = () => {
  const theme = resolveTheme(useSettings.getState().themePreference, getOsTheme())
  if (theme !== appliedTheme) {
    appliedTheme = theme
    applyTheme(theme)
  }
}

/** 首屏渲染前同步应用一次，之后随主题设置与宿主/系统深浅色变化更新 */
export const setupTheme = () => {
  syncTheme()
  if (themeInitialized) return
  themeInitialized = true
  query?.addEventListener('change', syncTheme)
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    })
  }
  useSettings.subscribe(syncTheme)
}
