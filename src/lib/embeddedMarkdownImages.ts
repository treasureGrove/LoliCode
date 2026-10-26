import { markdownLanguage } from "@codemirror/lang-markdown";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 16;
// Image URLs are shortened before this preprocessing parse. The reader keeps
// its own, smaller limit for rich Markdown rendering.
const MAX_PREPROCESS_LENGTH = 1024 * 1024;
const TOKEN_PREFIX = "https://lolicode.invalid/embedded-image/";

type MarkdownNode = ReturnType<typeof markdownLanguage.parser.parse>["topNode"];

interface Candidate {
  token: string;
  source: string;
  to: number;
  shortTo: number;
  bytes: number | null;
}

interface Edit {
  from: number;
  to: number;
  text: string;
}

const children = (node: MarkdownNode) => {
  const result: MarkdownNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling)
    result.push(child);
  return result;
};

const normalizeLabel = (label: string) =>
  label
    .replace(/^\[|\]$/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

/**
 * Keep image payloads out of the Markdown renderer. Only AST-confirmed image
 * targets are changed; temporary substitutions in code and literal text are
 * never copied back to the returned source.
 */
export function prepareEmbeddedMarkdownImages(content: string) {
  const images = new Map<string, string>();
  if (!/data:image\//i.test(content)) return { content, images };

  const candidates: Candidate[] = [];
  const byToken = new Map<string, Candidate>();
  const shortened: string[] = [];
  let cursor = 0;
  let shortLength = 0;
  let nextToken = 0;
  const usedTokens = new Set(
    content.match(/https:\/\/lolicode\.invalid\/embedded-image\/\d+/g),
  );
  for (const match of content.matchAll(
    /data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,([A-Za-z0-9+/]+={0,2})/gi,
  )) {
    const from = match.index!;
    const before = content.slice(cursor, from);
    shortened.push(before);
    shortLength += before.length;
    let token: string;
    do token = `${TOKEN_PREFIX}${nextToken++}`;
    while (usedTokens.has(token));
    const payload = match[1];
    const candidate: Candidate = {
      token,
      source: match[0],
      to: from + match[0].length,
      shortTo: shortLength + token.length,
      bytes:
        payload.length % 4 === 0
          ? (payload.length / 4) * 3 -
            (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0)
          : null,
    };
    candidates.push(candidate);
    byToken.set(token, candidate);
    shortened.push(token);
    shortLength += token.length;
    cursor = candidate.to;
  }
  if (!candidates.length) return { content, images };
  shortened.push(content.slice(cursor));
  const source = shortened.join("");
  if (source.length > MAX_PREPROCESS_LENGTH) return { content, images };

  // All edits use original offsets. Binary search makes many small images or
  // reference uses independent of the size of their preceding payloads.
  const originalOffset = (position: number) => {
    let low = 0;
    let high = candidates.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[middle].shortTo <= position) low = middle + 1;
      else high = middle;
    }
    const previous = candidates[low - 1];
    return previous ? position + previous.to - previous.shortTo : position;
  };
  const originalSlice = (from: number, to: number) =>
    content.slice(originalOffset(from), originalOffset(to));
  const targetCandidate = (node: MarkdownNode) => {
    const url = node.getChild("URL");
    if (!url) return undefined;
    return byToken.get(source.slice(url.from, url.to).replace(/^<|>$/g, ""));
  };
  const root = markdownLanguage.parser.parse(source).topNode;
  const references = new Map<
    string,
    { candidate: Candidate | undefined; node: MarkdownNode }
  >();
  const visitReferences = (node: MarkdownNode) => {
    if (node.name === "LinkReference") {
      const label = node.getChild("LinkLabel");
      if (label) {
        const key = normalizeLabel(source.slice(label.from, label.to));
        if (!references.has(key))
          references.set(key, { candidate: targetCandidate(node), node });
      }
    }
    children(node).forEach(visitReferences);
  };
  visitReferences(root);

  const edits: Edit[] = [];
  const consumedReferences = new Set<MarkdownNode>();
  let totalBytes = 0;
  let imageCount = 0;
  const visitImages = (node: MarkdownNode) => {
    if (node.name === "Image") {
      const marks = children(node).filter((child) => child.name === "LinkMark");
      if (marks.length >= 2) {
        const labelFrom = marks[0].to;
        const labelTo = marks[1].from;
        const labelNode = node.getChild("LinkLabel");
        const explicitLabel = labelNode
          ? normalizeLabel(source.slice(labelNode.from, labelNode.to))
          : "";
        const reference = node.getChild("URL")
          ? undefined
          : references.get(
              explicitLabel || normalizeLabel(source.slice(labelFrom, labelTo)),
            );
        const candidate = targetCandidate(node) ?? reference?.candidate;
        if (candidate) {
          const alt = originalSlice(labelFrom, labelTo);
          let text = `图片无法显示${alt ? `：${alt}` : ""}`;
          if (
            candidate.bytes !== null &&
            candidate.bytes <= MAX_IMAGE_BYTES &&
            imageCount < MAX_IMAGES &&
            totalBytes + candidate.bytes <= MAX_TOTAL_IMAGE_BYTES
          ) {
            images.set(candidate.token, candidate.source);
            totalBytes += candidate.bytes;
            imageCount++;
            text = `![${alt}](${candidate.token})`;
          }
          edits.push({
            from: originalOffset(node.from),
            to: originalOffset(node.to),
            text,
          });
          if (reference) consumedReferences.add(reference.node);
          return;
        }
      }
    }
    children(node).forEach(visitImages);
  };
  visitImages(root);
  consumedReferences.forEach((node) =>
    edits.push({
      from: originalOffset(node.from),
      to: originalOffset(node.to),
      text: "",
    }),
  );
  if (!edits.length) return { content, images };
  edits.sort((left, right) => left.from - right.from);
  const result: string[] = [];
  cursor = 0;
  for (const edit of edits) {
    result.push(content.slice(cursor, edit.from), edit.text);
    cursor = edit.to;
  }
  result.push(content.slice(cursor));
  return { content: result.join(""), images };
}
