import type { SVGProps } from "react";

export type WorkspaceGlyphKind = "models" | "chat" | "automation" | "plugins";

export interface WorkspaceGlyphProps extends SVGProps<SVGSVGElement> {
  kind: WorkspaceGlyphKind;
}

/** Shared navigation silhouettes; color and size inherit the active theme. */
export function WorkspaceGlyph({ kind, ...props }: WorkspaceGlyphProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {kind === "models" && (
        <>
          <path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" />
          <path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5" />
        </>
      )}
      {kind === "chat" && (
        <>
          <path d="M6 3.5h7a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H7l-4 3v-10a3 3 0 0 1 3-3Z" />
          <path d="M19 8a3 3 0 0 1 2 2.8V21l-4-3h-5a3 3 0 0 1-2.8-2" />
        </>
      )}
      {kind === "automation" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m13 6-5 7h4l-1 5 5-7h-4l1-5Z" />
        </>
      )}
      {kind === "plugins" && (
        <>
          <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5" />
          <rect x="3.5" y="14" width="6.5" height="6.5" rx="1.5" />
          <rect x="14" y="14" width="6.5" height="6.5" rx="1.5" />
          <rect
            x="14"
            y="3.5"
            width="6.5"
            height="6.5"
            rx="1.5"
            transform="rotate(12 17.25 6.75)"
          />
        </>
      )}
    </svg>
  );
}
