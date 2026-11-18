import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

/** 窄于 768px 按移动端布局 */
const query =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('not all and (min-width: 768px)')
    : null

const subscribe = (onChange: () => void) => {
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}

export const useIsMobile = () =>
  useSyncExternalStore(
    subscribe,
    () => query?.matches ?? false,
    () => false
  )

const preventPageScroll = (event: TouchEvent) => {
  if (event.touches.length !== 1) {
    return
  }
  for (
    let element = event.target instanceof Element ? event.target : null;
    element && element !== document.body;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element)
    const scrollsY =
      /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight
    const scrollsX =
      /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth
    if (scrollsY || scrollsX) {
      return
    }
  }
  event.preventDefault()
}

/** 阻止移动端整页滚动，保留内部可滚动区域的滚动和双指缩放。 */
export const usePreventPageScroll = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) {
      return
    }
    document.addEventListener('touchmove', preventPageScroll, { passive: false })
    return () => document.removeEventListener('touchmove', preventPageScroll)
  }, [enabled])
}

/** 移动端页面跟随视觉视口，键盘弹出后顶栏和输入框仍留在可见区域。 */
export const useMobileViewport = (enabled: boolean) => {
  const frameRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!enabled || !frame) {
      return
    }
    const viewport = window.visualViewport
    const inputSelector = 'textarea, input:not([type="file"])'
    let animationFrame = 0
    const reset = () => {
      frame.style.removeProperty('--app-viewport-height')
      frame.style.removeProperty('--app-viewport-top')
    }
    const update = () => {
      // 双指缩放由浏览器处理，保持当前布局尺寸。
      if (viewport && viewport.scale !== 1) {
        return
      }
      // 失焦后直接恢复 CSS 的全高布局，不等 Safari 收键盘后的 resize。
      if (!document.activeElement?.matches(inputSelector)) {
        reset()
        return
      }
      frame.style.setProperty(
        '--app-viewport-height',
        `${viewport?.height ?? window.innerHeight}px`
      )
      frame.style.setProperty('--app-viewport-top', `${viewport?.offsetTop ?? 0}px`)
    }
    const scheduleFrame = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(update)
    }
    const schedule = () => {
      // 先同步跟上键盘动画，下一帧再校准 Safari 延迟更新的视口读数。
      update()
      scheduleFrame()
    }
    const onFocusIn = () => {
      if (document.activeElement?.matches(inputSelector)) {
        schedule()
      }
    }

    update()
    viewport?.addEventListener('resize', schedule)
    viewport?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    document.addEventListener('focusin', onFocusIn)
    // 等点击和焦点切换完成，避免按钮移动、或切换输入框时短暂恢复全高。
    document.addEventListener('focusout', scheduleFrame)
    return () => {
      cancelAnimationFrame(animationFrame)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', scheduleFrame)
      reset()
    }
  }, [enabled])

  return frameRef
}
