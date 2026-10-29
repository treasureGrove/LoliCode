import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { AgentMessageView } from "@/features/agent/AgentParts";
import { AgentImage } from "@/features/agent/AgentImage";
import { AgentFileActionsContext } from "@/features/agent/AgentFilePath";
import { SessionMarkdown } from "@/features/sessions/reader/SessionMarkdown";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const data = {
  dataUrl: "data:image/png;base64,aGVsbG8=",
  mediaType: "image/png",
};
beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(data);
});

describe("generated agent image previews", () => {
  function reply(text: string) {
    return render(
      <AgentMessageView
        sessionId="zc:fixture"
        projectPath="C:/project"
        message={{
          id: "assistant",
          role: "assistant",
          createdAt: 1,
          parts: [{ type: "text", text }],
        }}
      />,
    );
  }

  it("displays a remote assistant image inline and opens its preview", async () => {
    reply("![效果图](https://example.com/generated.png)");
    expect(screen.getByRole("img", { name: "效果图" })).toHaveAttribute(
      "src",
      "https://example.com/generated.png",
    );
    expect(
      screen.queryByRole("button", { name: /加载远程图片/ }),
    ).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "放大查看图片：效果图" }),
    );
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it("renders a large embedded image without exposing base64 or losing surrounding Markdown", async () => {
    const src = `data:image/png;base64,${"AAAA".repeat(20000)}`;
    const view = reply(
      `**生成完成**\n\n![生成图](${src})\n\n下面可以继续调整。`,
    );
    expect(screen.getByRole("img", { name: "生成图" })).toHaveAttribute(
      "src",
      src,
    );
    expect(screen.getByText("生成完成").tagName).toBe("STRONG");
    expect(screen.getByText("下面可以继续调整。")).toBeVisible();
    expect(view.container).not.toHaveTextContent("data:image/");
    fireEvent.click(
      screen.getByRole("button", { name: "放大查看图片：生成图" }),
    );
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps embedded images visible when a long reply uses the plain-text fallback", () => {
    const src = `data:image/png;base64,${"AAAA".repeat(20000)}`;
    const view = reply(
      `${"正文".repeat(35000)}\n\n![图](${src})\n\n图后说明。`,
    );
    expect(screen.getByRole("img", { name: "图" })).toHaveAttribute("src", src);
    expect(view.container).toHaveTextContent("图后说明。");
    expect(view.container).not.toHaveTextContent("data:image/");
  });

  it("leaves embedded image examples inside code and escaped syntax untouched", () => {
    const src = "data:image/png;base64,aGVsbG8=";
    const example = `![示例](${src})`;
    const view = reply(
      `\`${example}\`\n\n\`\`\`md\n${example}\n\`\`\`\n\n    ${example}\n\n\\${example}`,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(view.container).toHaveTextContent(src);
    expect(view.container).not.toHaveTextContent("lolicode.invalid");
  });

  it("keeps rejected image payloads out of a long plain-text fallback", () => {
    const view = reply(
      `${"正文".repeat(35000)}\n\n![图片](data:image/png;base64,AAAAA)`,
    );
    expect(view.container).toHaveTextContent("图片无法显示：图片");
    expect(view.container).not.toHaveTextContent("data:image/");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it.each([
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:text/html;base64,PGgxPng8L2gxPg==",
    "javascript:alert(1)",
  ])(
    "does not turn an unsupported image target into active content: %s",
    (src) => {
      const view = reply(`![图片](${src})`);
      expect(view.container.querySelector("img")).toBeNull();
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("keeps the reader's remote-image loading control", () => {
    render(
      <SessionMarkdown content="![阅读器图片](https://example.com/read.png)" />,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /加载远程图片/ })).toBeVisible();
  });

  it("offers a retry instead of opening a broken data image as an external link", () => {
    reply("![生成图](data:image/png;base64,aGVsbG8=)");
    fireEvent.error(screen.getByRole("img", { name: "生成图" }));
    expect(screen.getByRole("status")).toHaveTextContent("图片无法显示");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载图片" }));
    expect(screen.getByRole("img", { name: "生成图" })).toHaveAttribute(
      "src",
      "data:image/png;base64,aGVsbG8=",
    );
  });

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
    "loads a generated image through the session-scoped backend: $text",
    async ({ text, path }) => {
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
      const image = await screen.findByRole("button", {
        name: "放大图片：生成结果",
      });
      expect(screen.getByRole("img", { name: "生成结果" })).toHaveAttribute(
        "src",
        data.dataUrl,
      );
      expect(invoke).toHaveBeenCalledWith("get_agent_image", {
        sessionId: "zc:fixture",
        path,
      });
      fireEvent.click(image);
      expect(await screen.findByRole("dialog")).toBeVisible();
      expect(preview).not.toHaveBeenCalled();
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
