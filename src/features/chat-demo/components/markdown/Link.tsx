import type { Image, Link as LinkNode } from 'mdast'
import { memo, type ReactNode } from 'react'

const sanitizeUrl = (url: string) => {
  // 如果URL没有协议，添加默认的https协议
  if (url && !url.match(/^[a-zA-Z]+:\/\//) && !url.startsWith('mailto:')) {
    url = `https://${url}`
  }

  try {
    const parsedUrl = new URL(url)
    if (['http:', 'https:', 'mailto:'].includes(parsedUrl.protocol)) {
      return parsedUrl.toString()
    }
    return undefined
  } catch {
    return undefined
  }
}

export const Link = memo(function Link({
  node,
  children,
}: {
  node: LinkNode
  children: ReactNode
}) {
  // 页内锚点显示链接文字。
  if (node.url.startsWith('#')) {
    return children
  }

  // 邮件地址显示链接文字。
  if (node.url.startsWith('mailto:')) {
    return children
  }

  // URL 解析失败时 href 为空，链接文字仍可显示。
  const href = sanitizeUrl(node.url)

  return (
    <a href={href} title={node.title || undefined} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
})

/** Markdown 图片显示为指向图片地址的链接 */
export function ImageAsLink({ node }: { node: Image }) {
  const url = sanitizeUrl(node.url)
  return (
    <a href={url} title={node.title ?? ''} target="_blank" rel="noreferrer">
      {url}
    </a>
  )
}
