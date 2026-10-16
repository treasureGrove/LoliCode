import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { AgentMessageView } from "@/components/agent/AgentParts";
import { AgentImage } from "@/components/agent/AgentImage";
import { AgentFileActionsContext } from "@/components/agent/AgentFilePath";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const data = {
  dataUrl: "data:image/png;base64,aGVsbG8=",
  mediaType: "image/png",
};
beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(data);
});

describe("generated agent image previews", () => {
  it.each([
    {
      text: "![生成结果](/tmp/project/result.png)",
      path: "/tmp/project/result.png",
    },
    {
      text: "![生成结果](<C:/project/generated image.png>)",
      path: "C:/project/generated image.png",
    },
    { text: "![生成结果](./outputs/result.png)", path: "./outputs/result.png" },
    { text: "[生成结果](outputs/result.png)", path: "outputs/result.png" },
    {
      text: "![生成结果][output]\n\n[output]: ./outputs/result.png",
      path: "./outputs/result.png",
    },
  ])(
    "routes a generated image into the project preview: $text",
    ({ text, path }) => {
      const preview = vi.fn();
      render(
        <AgentFileActionsContext.Provider
          value={{
            sessionId: "zc:fixture",
            projectPath: "C:/project",
            onPreview: preview,
          }}
        >
          <AgentMessageView
            sessionId="zc:fixture"
            projectPath="C:/project"
            message={{
              id: "assistant",
              role: "assistant",
              createdAt: 1,
              parts: [{ type: "text", text }],
            }}
          />
        </AgentFileActionsContext.Provider>,
      );
      const link = screen.getByRole("button", { name: `预览文件：${path}` });
      expect(link).toHaveTextContent("生成结果");
      expect(
        screen.queryByRole("img", { name: "生成结果" }),
      ).not.toBeInTheDocument();
      fireEvent.click(link);
      expect(preview).toHaveBeenCalledWith(path);
      // Loading is owned by the preview panel; markdown rendering does not eagerly fetch images.
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("supports zoom and closing the image preview with Escape", async () => {
    render(
      <AgentImage
        sessionId="zc:fixture"
        projectPath="C:/project"
        path="result.png"
        alt="预览"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "放大图片：预览" }),
    );
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("keeps a readable failure and lets the user retry after the file is generated", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("图片不存在或无法访问");
    render(
      <AgentImage
        sessionId="zc:fixture"
        projectPath="C:/project"
        path="result.png"
        alt="预览"
      />,
    );
    expect(await screen.findByText("图片不存在或无法访问")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重新加载图片" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "预览" })).toHaveAttribute(
        "src",
        data.dataUrl,
      ),
    );
  });

  it("does not display a stale image after switching the target", async () => {
    let finish!: (value: typeof data) => void;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve as typeof finish;
        }),
    );
    const view = render(
      <AgentImage
        sessionId="zc:fixture"
        projectPath="C:/project"
        path="old.png"
        alt="旧图片"
      />,
    );
    view.rerender(
      <AgentImage
        sessionId="zc:fixture"
        projectPath="C:/project"
        path="new.png"
        alt="新图片"
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "新图片" })).toHaveAttribute(
        "src",
        data.dataUrl,
      ),
    );
    finish({ dataUrl: "data:image/png;base64,b2xk", mediaType: "image/png" });
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "新图片" })).toHaveAttribute(
        "src",
        data.dataUrl,
      ),
    );
  });
});
