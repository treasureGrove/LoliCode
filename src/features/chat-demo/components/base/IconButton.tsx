import clsx from 'clsx'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Tooltip, type TooltipPlacement } from './Tooltip.js'
import styles from './IconButton.module.css'

/**
 * xs 为 28px（图标 16px）、m 为 34px、xl 为 44px（图标 20px）。
 * tooltip 同时作为无障碍名称；没有 tooltip 的按钮通过 aria-label 提供名称
 */
export const IconButton = ({
  icon,
  size = 'xs',
  tone = 'tertiary',
  tooltip,
  tooltipPlacement,
  className,
  ...props
}: {
  icon: ReactNode
  size?: 'xs' | 'm' | 'xl'
  tone?: 'tertiary' | 'primary'
  tooltip?: string
  tooltipPlacement?: TooltipPlacement
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'>) => {
  const button = (
    <button
      type="button"
      className={clsx(styles.button, styles[size], styles[tone], className)}
      aria-label={tooltip}
      {...props}
    >
      {icon}
    </button>
  )
  return tooltip ? (
    <Tooltip content={tooltip} placement={tooltipPlacement}>
      {button}
    </Tooltip>
  ) : (
    button
  )
}
