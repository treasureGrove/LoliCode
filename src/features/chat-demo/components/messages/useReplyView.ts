import { useMemo, useState } from 'react'
import type { AssistantMessage } from '../../services/chat/types.js'
import { buildReplyView, type Source } from '../../services/chat/view.js'

const sameSource = (a: Source, b: Source) =>
  a.url === b.url &&
  a.title === b.title &&
  a.siteName === b.siteName &&
  a.publishedAt === b.publishedAt &&
  a.snippet === b.snippet &&
  a.siteIcon === b.siteIcon &&
  a.index === b.index

/**
 * 将助手消息转换为界面渲染所需的回复视图数据：步骤时间线、正文、引用来源和搜索结果。
 * 来源内容未变时复用 sources 数组，避免流式文本更新绕过 Markdown 的解析节流。
 */
export const useReplyView = (message: AssistantMessage, streaming: boolean) => {
  const view = useMemo(() => buildReplyView(message, streaming), [message, streaming])
  const [sources, setSources] = useState(view.sources)

  // 仅来源编号、顺序或元数据变化时更新状态，普通文本增量沿用已有数组。
  if (
    sources !== view.sources &&
    (sources.length !== view.sources.length ||
      !sources.every((source, index) => sameSource(source, view.sources[index])))
  ) {
    setSources(view.sources)
  }

  return useMemo(() => ({ ...view, sources }), [view, sources])
}
