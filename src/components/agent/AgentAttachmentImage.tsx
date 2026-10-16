import { memo, useState } from "react";
import type { AgentImageAttachment } from "@/types/agent";
import { SessionImageLightbox } from "@/components/sessions/reader/SessionImageLightbox";

export const AgentAttachmentImage = memo(function AgentAttachmentImage({
  image,
  buttonClassName,
  imageClassName,
}: {
  image: AgentImageAttachment;
  buttonClassName: string;
  imageClassName: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label={`放大查看图片：${image.fileName}`}
        title="点击放大查看"
        onClick={() => setOpen(true)}
        className={buttonClassName}
      >
        <img
          src={image.dataUrl}
          alt={image.fileName}
          loading="lazy"
          decoding="async"
          className={imageClassName}
        />
      </button>
      {open && (
        <SessionImageLightbox
          open={open}
          onOpenChange={setOpen}
          url={image.dataUrl}
          alt={image.fileName}
          mediaType={image.mime}
        />
      )}
    </>
  );
});
