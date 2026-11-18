import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react'

/** 浮层与视口边缘的最小间距 */
export const VIEWPORT_PADDING = 8

export type Side = 'top' | 'bottom'
export type Align = 'start' | 'center' | 'end'

export type AnchoredPosition = {
  top: number
  left?: number
  right?: number
  maxHeight?: number
}

export type AnchoredOptions = {
  /** 优先出现的一侧，放不下时翻到另一侧 */
  side?: Side
  /** 相对触发元素的水平对齐方式 */
  align?: Align
  /** 水平方向的额外偏移，在按视口边缘收口之前叠加 */
  alignOffset?: number
  /** 与触发元素之间的间距 */
  offset?: number
  /**
   * 浮层纵向可用高度的上限。给出时按视口剩余空间收缩并允许滚动，
   * 未给出时按浮层自身高度整体摆放。
   */
  maxHeight?: number
  /** 判定「空间不足、需要翻面」的最小纵向空间 */
  minSpace?: number
  /**
   * 用触发元素的第一个子元素作为测量与对齐基准。触发元素自身不产生盒子时
   * （如 display: contents），它的 getBoundingClientRect 是空矩形。
   */
  measureFirstChild?: boolean
  /**
   * 浮层内容标识，变化时在绘制前同步重新测量。内容变化交给 ResizeObserver 会先按
   * 旧位置绘制一帧再回弹，所以需要这个同步入口。
   */
  measureKey?: unknown
}

const clampLeft = (left: number, width: number) =>
  Math.max(VIEWPORT_PADDING, Math.min(left, window.innerWidth - width - VIEWPORT_PADDING))

const alignLeft = (anchor: DOMRect, width: number, align: Align, alignOffset: number) => {
  if (align === 'center') {
    return clampLeft(anchor.left + anchor.width / 2 - width / 2 + alignOffset, width)
  }
  if (align === 'end') {
    return Math.max(VIEWPORT_PADDING, anchor.right - width + alignOffset)
  }
  return clampLeft(anchor.left + alignOffset, width)
}

/** 只有一侧放得下时用那一侧；两侧都放得下用优先侧；都放不下时退到空间更大的一侧 */
const resolveSide = (spaceAbove: number, spaceBelow: number, preferred: Side, needed: number) => {
  const fitsAbove = spaceAbove >= needed
  const fitsBelow = spaceBelow >= needed
  if (fitsAbove && !fitsBelow) {
    return 'top'
  }
  if (fitsBelow && !fitsAbove) {
    return 'bottom'
  }
  if (fitsAbove) {
    return preferred
  }
  return spaceAbove > spaceBelow ? 'top' : 'bottom'
}

/**
 * 相对触发元素给浮层定位。浮层挂在 body 上并用 position: fixed 按视口坐标摆放，
 * 因此需要在挂载后测量自身尺寸：未测量到之前位置为 null。
 */
export const useAnchoredPosition = <T extends HTMLElement, F extends HTMLElement>(
  open: boolean,
  {
    side = 'bottom',
    align = 'start',
    alignOffset = 0,
    offset = 4,
    maxHeight,
    minSpace = 160,
    measureFirstChild = false,
    measureKey,
  }: AnchoredOptions = {}
) => {
  const anchorRef = useRef<T | null>(null) as MutableRefObject<T | null>
  const floatingRef = useRef<F | null>(null) as MutableRefObject<F | null>
  const [position, setPosition] = useState<AnchoredPosition | null>(null)

  /** 位置没有实际变化时不更新状态，避免重新测量引起多余渲染 */
  const applyPosition = useCallback((next: AnchoredPosition) => {
    setPosition((previous) =>
      previous &&
      previous.top === next.top &&
      previous.left === next.left &&
      previous.right === next.right &&
      previous.maxHeight === next.maxHeight
        ? previous
        : next
    )
  }, [])

  /** 触发元素自身不产生盒子时（如 display: contents），用它第一个子元素测量 */
  const getAnchor = useCallback(
    () =>
      measureFirstChild
        ? (anchorRef.current?.firstElementChild as HTMLElement | null)
        : anchorRef.current,
    [anchorRef, measureFirstChild]
  )

  // 测量只在浮层打开且已挂载后进行，ref 对象稳定，回调不随渲染重建
  const update = useCallback(() => {
    const anchor = getAnchor()
    const floating = floatingRef.current
    if (!anchor || !floating) {
      return
    }
    const rect = anchor.getBoundingClientRect()
    const spaceAbove = rect.top - offset - VIEWPORT_PADDING
    const spaceBelow = window.innerHeight - rect.bottom - offset - VIEWPORT_PADDING

    if (maxHeight === undefined) {
      const { width, height } = floating.getBoundingClientRect()
      const resolved = resolveSide(spaceAbove, spaceBelow, side, height)
      applyPosition({
        top: resolved === 'top' ? rect.top - offset - height : rect.bottom + offset,
        left: alignLeft(rect, width, align, alignOffset),
      })
      return
    }

    const resolved = resolveSide(spaceAbove, spaceBelow, side, minSpace)
    const available = Math.max(0, resolved === 'top' ? spaceAbove : spaceBelow)
    // 内容比可用空间小时按内容收口，避免浮层留出多余空白
    const height = Math.max(40, Math.min(maxHeight, available, floating.scrollHeight + 2))
    applyPosition({
      top:
        resolved === 'top'
          ? Math.max(VIEWPORT_PADDING, rect.top - offset - height)
          : rect.bottom + offset,
      right: Math.max(VIEWPORT_PADDING, window.innerWidth - rect.right),
      maxHeight: height,
    })
  }, [align, alignOffset, applyPosition, floatingRef, getAnchor, maxHeight, minSpace, offset, side])

  // 打开时与内容变化时同步测量，必须在绘制前完成
  useLayoutEffect(() => {
    if (open) {
      update()
    }
  }, [measureKey, open, update])

  /*
   * 打开期间跟踪渲染时无法预知的位置来源：浮层或触发元素尺寸变化、窗口尺寸变化、
   * 任意滚动容器滚动。对应 @floating-ui 的 autoUpdate，避免浮层停在旧位置。
   */
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    const floating = floatingRef.current
    if (!floating) {
      return
    }
    const anchor = getAnchor()
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => update()) : null
    observer?.observe(floating)
    if (anchor) {
      observer?.observe(anchor)
    }
    window.addEventListener('scroll', update, { capture: true, passive: true })
    window.addEventListener('resize', update, { passive: true })
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', update, { capture: true })
      window.removeEventListener('resize', update)
    }
  }, [floatingRef, getAnchor, open, update])

  useEffect(() => {
    if (!open) {
      setPosition(null)
    }
  }, [open])

  return { anchorRef, floatingRef, position }
}

/** 点击浮层与触发元素之外、或按 Esc 时关闭 */
export const useDismiss = (
  open: boolean,
  refs: RefObject<HTMLElement | null>[],
  onDismiss: () => void,
  { captureEscape = false }: { captureEscape?: boolean } = {}
) => {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  const refsRef = useRef(refs)
  refsRef.current = refs

  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      const inside = refsRef.current.some((ref) => ref.current?.contains(target))
      if (!inside) {
        onDismissRef.current()
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      if (captureEscape) {
        event.stopPropagation()
      }
      onDismissRef.current()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, captureEscape)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, captureEscape)
    }
  }, [open, captureEscape])
}

/** 悬停类浮层的进出延迟：同一时间只有一个待执行的切换 */
export const useDelayedOpen = () => {
  const [open, setOpen] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const schedule = useCallback((next: boolean, delay: number) => {
    window.clearTimeout(timer.current)
    if (delay <= 0) {
      setOpen(next)
      return
    }
    timer.current = window.setTimeout(() => setOpen(next), delay)
  }, [])
  const cancel = useCallback(() => window.clearTimeout(timer.current), [])
  return { open, setOpen, schedule, cancel }
}
