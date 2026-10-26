import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  AgentPreviewPanel,
  isolatedAgentHtml,
} from "@/components/agent/AgentPreviewPanel";
import {
  AgentFileActionsContext,
  AgentFilePath,
} from "@/components/agent/AgentFilePath";
import { AgentMessageView } from "@/components/agent/AgentParts";
import { agentFilesApi, type AgentFilePreview } from "@/lib/api/agent-files";

vi.mock("@/lib/api/agent-files", () => ({
  agentFilesApi: { preview: vi.fn(), open: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/components/agent/AgentDocumentViewer", async (original) => ({
  ...(await original<
    typeof import("@/components/agent/AgentDocumentViewer")
  >()),
  AgentDocumentViewer: () => (
    <section aria-label="文档查看器">Office 内容</section>
  ),
}));
const file = (values: Partial<AgentFilePreview> = {}): AgentFilePreview => ({
  kind: "text",
  name: "readme.txt",
  path: "/project/readme.txt",
  mimeType: "text/plain",
  content: "file content",
  sizeBytes: 12,
  truncated: false,
  ...values,
});
beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue({
    dataUrl: "data:image/png;base64,aGVsbG8=",
    mediaType: "image/png",
  });
  vi.mocked(agentFilesApi.preview).mockReset().mockResolvedValue(file());
  vi.mocked(agentFilesApi.open).mockReset().mockResolvedValue();
});

describe("Agent file previews", () => {
  it("keeps Office chrome compact and restores an expanded reader with Escape", () => {
    render(
      <AgentPreviewPanel
        sessionId="lc:session"
        path="notes.docx#p:2"
        width={480}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("notes.docx")).toBeVisible();
    expect(screen.queryByLabelText("预览文件路径")).not.toBeInTheDocument();
    expect(screen.queryByText("隔离预览")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放大文档预览" }));
    expect(screen.getByRole("dialog", { name: "文件预览" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放大文档预览" })).toHaveFocus();
    expect(agentFilesApi.preview).not.toHaveBeenCalled();
  });

  it("opens the path picker on demand and returns to the normal file preview", async () => {
    render(
      <AgentPreviewPanel
        sessionId="lc:session"
        path="notes.xlsx"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "放大文档预览" }));
    fireEvent.click(screen.getByRole("button", { name: "切换预览文件" }));
    fireEvent.change(screen.getByLabelText("预览文件路径"), {
      target: { value: "readme.txt" },
    });
    expect(agentFilesApi.preview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^预览$/ }));
    expect(await screen.findByText("file content")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(agentFilesApi.preview).toHaveBeenCalledWith(
      "lc:session",
      "readme.txt",
    );
    expect(screen.getByLabelText("预览文件路径")).toBeVisible();
  });

  it("previews remote HTML through the same isolated renderer and never invokes local open actions", async () => {
    vi.mocked(agentFilesApi.preview).mockResolvedValue(
      file({
        kind: "html",
        name: "remote.html",
        remote: true,
        content: "<h1>Remote content</h1><script>doNotRun()</script>",
      }),
    );
    render(
      <AgentPreviewPanel
        sessionId="lc:remote"
        path="remote.html"
        onClose={vi.fn()}
      />,
    );
    await screen.findByText(/远程文件以只读方式预览/);
    expect(screen.getByRole("button", { name: "打开预览文件" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "打开预览所在文件夹" }),
    ).toBeDisabled();
    const frame = document.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("srcdoc")).not.toContain("doNotRun");
    expect(agentFilesApi.open).not.toHaveBeenCalled();
  });
  it("does not read a file until the user submits its path", async () => {
    render(
      <AgentPreviewPanel sessionId="lc:session" path="" onClose={vi.fn()} />,
    );
    expect(agentFilesApi.preview).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("预览文件路径"), {
      target: { value: "docs/readme.txt" },
    });
    expect(agentFilesApi.preview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^预览$/ }));
    expect(await screen.findByText("file content")).toBeVisible();
    expect(agentFilesApi.preview).toHaveBeenCalledWith(
      "lc:session",
      "docs/readme.txt",
    );
    fireEvent.click(screen.getByRole("button", { name: "打开预览所在文件夹" }));
    expect(agentFilesApi.open).toHaveBeenCalledWith(
      "lc:session",
      "docs/readme.txt",
      "directory",
    );
  });

  it("removes active HTML, navigation, external resources and SVG before adding a restrictive first CSP", () => {
    const html = isolatedAgentHtml(
      `<!doctype html><head><meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test"><style>@import 'https://evil.test/a.css';.x{background:url(https://evil.test/t)}</style></head><body onload="steal()"><h1>Local page</h1><script>window.location='https://evil.test'</script><iframe src="https://evil.test"></iframe><a href="https://evil.test" ping="https://evil.test">Go</a><img src="https://evil.test/a.png" srcset="https://evil.test/b.png 2x" onerror="steal()"><img src="data:image/png;base64,aGVsbG8="><img src="data:image/svg+xml;base64,aGVsbG8="><form action="https://evil.test"><input autofocus></form><svg><a href="https://evil.test">bad</a></svg></body>`,
    );
    expect(
      html.startsWith(
        '<!doctype html><html><head><meta http-equiv="Content-Security-Policy"',
      ),
    ).toBe(true);
    expect(html).toContain("<h1>Local page</h1>");
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelector("h1")?.textContent).toBe("Local page");
    expect(
      document.querySelector(
        "script,iframe,base,form,svg,meta[http-equiv='refresh']",
      ),
    ).toBeNull();
    expect(
      document.querySelector(
        "[href],[srcset],[ping],[onload],[onerror],[autofocus]",
      ),
    ).toBeNull();
    expect(document.querySelector("img[src]")?.getAttribute("src")).toBe(
      "data:image/png;base64,aGVsbG8=",
    );
    expect(document.querySelectorAll("img[src]")).toHaveLength(1);
    expect(document.querySelector("input")?.hasAttribute("disabled")).toBe(
      true,
    );
    expect(document.querySelector("style")?.textContent).not.toContain(
      "https://",
    );
    expect(
      document
        .querySelector("meta[http-equiv='Content-Security-Policy']")
        ?.getAttribute("content"),
    ).toContain("script-src 'none'");
  });

  it("frames sanitized HTML without scripts or shared origin and can switch to the original source", async () => {
    const content = '<h1>Demo</h1><script>alert("not run")</script>';
    vi.mocked(agentFilesApi.preview).mockResolvedValue(
      file({ kind: "html", name: "demo.html", content }),
    );
    render(
      <AgentPreviewPanel
        sessionId="lc:session"
        path="demo.html"
        onClose={vi.fn()}
      />,
    );
    const frame = await screen.findByTitle("HTML 预览：demo.html");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame.getAttribute("srcdoc")).not.toContain("<script>");
    expect(screen.getByText(/静态预览不执行脚本/)).not.toBeVisible();
    fireEvent.click(screen.getByText("隔离预览"));
    expect(screen.getByText(/静态预览不执行脚本/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    expect(screen.queryByTitle("HTML 预览：demo.html")).not.toBeInTheDocument();
    expect(screen.getByText(content)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "打开预览文件" }));
    expect(agentFilesApi.open).toHaveBeenCalledWith(
      "lc:session",
      "demo.html",
      "file",
    );
  });

  it("ignores a late preview result after another file replaces the panel", async () => {
    let finish!: (value: AgentFilePreview) => void;
    vi.mocked(agentFilesApi.preview).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(
      <AgentPreviewPanel
        key="old"
        sessionId="lc:session"
        path="old.txt"
        onClose={vi.fn()}
      />,
    );
    view.rerender(
      <AgentPreviewPanel
        key="new"
        sessionId="lc:other"
        path="new.txt"
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText("file content")).toBeVisible();
    await act(async () => finish(file({ content: "stale content" })));
    expect(screen.queryByText("stale content")).not.toBeInTheDocument();
    expect(agentFilesApi.preview).toHaveBeenLastCalledWith(
      "lc:other",
      "new.txt",
    );
  });

  it("displays a safe SVG returned by the session-scoped preview API", async () => {
    const dataUrl =
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCIvPjwvc3ZnPg==";
    vi.mocked(agentFilesApi.preview).mockResolvedValue(
      file({
        kind: "image",
        name: "diagram.svg",
        mimeType: "image/svg+xml",
        dataUrl,
      }),
    );
    render(
      <AgentPreviewPanel
        sessionId="lc:session"
        path="diagram.svg"
        onClose={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("img", { name: "diagram.svg" }),
    ).toHaveAttribute("src", dataUrl);
    expect(agentFilesApi.preview).toHaveBeenCalledWith(
      "lc:session",
      "diagram.svg",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders session-scoped image previews without repeated assistant headers and keeps file actions", async () => {
    const preview = vi.fn();
    const view = render(
      <AgentFileActionsContext.Provider
        value={{ sessionId: "lc:session", onPreview: preview }}
      >
        <AgentMessageView
          sessionId="lc:session"
          projectPath="/project"
          message={{
            id: "assistant",
            role: "assistant",
            createdAt: 1,
            parts: [
              {
                type: "text",
                text: "![Screenshot](/project/shot.png)\n[file](/project/result.html)",
              },
            ],
          }}
        />
      </AgentFileActionsContext.Provider>,
    );
    expect(agentFilesApi.preview).not.toHaveBeenCalled();
    expect(view.container.querySelector(".wb-message-meta")).toBeNull();
    expect(
      await screen.findByRole("button", { name: "放大图片：Screenshot" }),
    ).toBeVisible();
    expect(invoke).toHaveBeenCalledWith("get_agent_image", {
      sessionId: "lc:session",
      path: "/project/shot.png",
    });
    expect(preview).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "打开所在文件夹：/project/result.html",
      }),
    );
    await waitFor(() =>
      expect(agentFilesApi.open).toHaveBeenCalledWith(
        "lc:session",
        "/project/result.html",
        "directory",
      ),
    );
  });

  it("keeps refused file actions visible and never opens files on hover", async () => {
    vi.mocked(agentFilesApi.open).mockRejectedValue(
      new Error("不能打开可执行文件"),
    );
    render(
      <AgentFileActionsContext.Provider
        value={{ sessionId: "lc:session", onPreview: vi.fn() }}
      >
        <AgentFilePath path="blocked.exe" />
      </AgentFileActionsContext.Provider>,
    );
    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "预览文件：blocked.exe" }),
    );
    expect(agentFilesApi.open).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "打开文件：blocked.exe" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "不能打开可执行文件",
    );
  });
});
