import clsx from 'clsx'
import type { ButtonHTMLAttributes } from 'react'
import styles from './Button.module.css'

export const Button = ({
  variant = 'primary',
  size = 'l',
  block = false,
  className,
  ...props
}: {
  variant?: 'primary' | 'outlined' | 'danger' | 'dangerOutlined'
  size?: 'l' | 'm' | 's'
  block?: boolean
} & ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    type="button"
    className={clsx(styles.button, styles[variant], styles[size], block && styles.block, className)}
    {...props}
  />
)
