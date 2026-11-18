import { useEffect, type HTMLAttributes, type MutableRefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDelayedOpen } from '../base/anchored.js'
import styles from './HoverCard.module.css'

const ENTER_DELAY = 300
const LEAVE_DELAY = 100
const GAP = 6

export type HoverCardTrigger = (props: {
  domRef: MutableRefObject<HTMLSpanElement | null>
  domProps: Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'className' | 'style'> | undefined
}) => ReactNode

/** 悬停 300ms 后在触发元素下方显示卡片（放不下则上方），鼠标可移入卡片 */
export const HoverCard = ({
  renderTrigger,
  children,
}: {
  renderTrigger: HoverCardTrigger
  children: ReactNode
}) => {
  const { open, schedule, cancel } = useDelayedOpen()
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { align: 'center', offset: GAP }
  )

  useEffect(() => () => cancel(), [cancel])

  return (
    <>
      {renderTrigger({
        domRef: anchorRef,
        domProps: {
          onMouseEnter: () => schedule(true, ENTER_DELAY),
          onMouseLeave: () => schedule(false, LEAVE_DELAY),
        },
      })}
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.card}
              style={position ?? { top: 0, left: 0, visibility: 'hidden' }}
              onMouseEnter={cancel}
              onMouseLeave={() => schedule(false, LEAVE_DELAY)}
            >
              {children}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
