import { memo, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PathChip } from "@/features/sessions/reader/PathChip";
import { SessionImageLightbox } from "@/features/sessions/reader/SessionImageLightbox";

type ImageResult = { dataUrl: string; mediaType: string };

/** Generated images use the session's backend project boundary, not arbitrary
 * file:// URLs or a broadly enabled WebView filesystem scope. */
export const AgentImage = memo(function AgentImage({
  sessionId,
  path,
  alt,
  projectPath,
}: {
  sessionId?: string;
  path: string;
  alt: string;
  projectPath: string;
}) {
  const [image, setImage] = useState<ImageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    setImage(null);
    setError(null);
    setOpen(false);
    if (!sessionId) return;
    void invoke<ImageResult>("get_agent_image", { sessionId, path }).then(
      (result) => {
        if (!disposed) setImage(result);
      },
      (cause: unknown) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      disposed = true;
    };
  }, [sessionId, path, retry]);
  const label = alt || path.split(/[\\/]/).pop() || "生成的图片";
  if (!sessionId) return <PathChip path={path} projectDir={projectPath} />;
  if (error)
    return (
      <span className="my-2 inline-flex flex-col gap-1 text-caption">
        <PathChip path={path} projectDir={projectPath} />
        <span role="status" className="text-fg-3">
          {error}
        </span>
        <button
          type="button"
          onClick={() => setRetry((value) => value + 1)}
          className="self-start underline"
        >
          重新加载图片
        </button>
      </span>
    );
  if (!image)
    return (
      <span
        role="img"
        aria-label={label}
        aria-busy
        className="my-2 inline-block h-40 w-full max-w-[420px] rounded-[8px] border border-border bg-subtle motion-safe:animate-pulse"
      />
    );
  return (
    <>
      <button
        type="button"
        aria-label={`放大图片：${label}`}
        onClick={() => setOpen(true)}
        className="my-2 inline-flex overflow-hidden rounded-[8px] border border-border bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img
          src={image.dataUrl}
          alt={label}
          loading="lazy"
          decoding="async"
          onError={() => setError("图片无法显示，请确认文件已完整生成后重试")}
          className="block max-h-[400px] max-w-full object-contain"
        />
      </button>
      {open && (
        <SessionImageLightbox
          open={open}
          onOpenChange={setOpen}
          url={image.dataUrl}
          alt={label}
          mediaType={image.mediaType}
        />
      )}
    </>
  );
});
