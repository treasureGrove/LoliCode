import type { CSSProperties } from 'react'
import clsx from 'clsx'
import { FallbackImage } from './FallbackImage.js'
import { IconLinkOutline14 } from '../base/icons.js'
import type { Source } from '../../services/chat/view.js'
import styles from './SiteLogo.module.css'

/** 站点图标：加载中显示骨架，没有图标或加载失败时显示链接图标 */
export const SiteLogo = ({
  url,
  className,
  style,
}: {
  url: string | null
  className?: string
  style?: CSSProperties
}) => (
  <FallbackImage
    key={url ?? ''}
    src={url ?? ''}
    fallback={<IconLinkOutline14 />}
    className={clsx(styles.logo, className)}
    imgClassName={styles.img}
    skeletonClassName={styles.placeholder}
    fallbackClassName={clsx(styles.placeholder, styles.fallback)}
    style={style}
  />
)

/** 搜索结果前 4 个站点的重叠缩略图 */
export const SiteThumbnails = ({ sources }: { sources: Source[] }) => (
  <span className={styles.group}>
    {sources.slice(0, 4).map((source) => (
      <SiteLogo key={source.url} url={source.siteIcon} className={styles.thumbnail} />
    ))}
  </span>
)
