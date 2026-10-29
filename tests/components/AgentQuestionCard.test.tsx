import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentQuestionCard } from "@/features/agent/AgentQuestionCard";
import type { AgentQuestion } from "@/types/agent";
import { settingsApi } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  settingsApi: { openExternal: vi.fn().mockResolvedValue(undefined) },
}));
const question = (fields: AgentQuestion["fields"]): AgentQuestion => ({
  id: "question-real",
  sessionId: "session-real",
  title: "选择实现方式",
  fields,
});
async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

describe("AgentQuestionCard", () => {
  it("shows one question at a time, preserves drafts when paging, and submits the batch only at the end", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          {
            key: "direction",
            type: "string",
            title: "实现方向",
            required: true,
            options: [
              {
                value: "small",
                label: "逐步迁移",
                description: "分阶段验证。",
              },
            ],
          },
          { key: "reason", type: "string", title: "补充理由", required: true },
        ])}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("第 1 / 2 题")).toBeVisible();
    expect(screen.queryByLabelText("补充理由")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一题" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请填写实现方向。");
    fireEvent.click(screen.getByRole("button", { name: "逐步迁移" }));
    expect(screen.getByText("第 1 / 2 题")).toBeVisible();
    expect(reply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    expect(screen.getByText("第 2 / 2 题")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "逐步迁移" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("补充理由")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("补充理由"), {
      target: { value: "每一步都可验证" },
    });
    fireEvent.click(screen.getByRole("button", { name: "上一题" }));
    expect(screen.getByRole("button", { name: "逐步迁移" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    expect(screen.getByLabelText("补充理由")).toHaveValue("每一步都可验证");
    expect(reply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await flush();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      direction: "small",
      reason: "每一步都可验证",
    });
  });

  it("continues text answers with Enter while preserving IME composition and Shift+Enter", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          { key: "first", type: "string", title: "第一题", required: true },
          { key: "second", type: "string", title: "第二题", required: true },
        ])}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    const first = screen.getByLabelText("第一题");
    fireEvent.change(first, { target: { value: "中文答案" } });
    fireEvent.keyDown(first, { key: "Enter", isComposing: true });
    fireEvent.keyDown(first, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(first, { key: "Enter", shiftKey: true });
    expect(screen.getByText("第 1 / 2 题")).toBeVisible();
    expect(reply).not.toHaveBeenCalled();
    fireEvent.keyDown(first, { key: "Enter" });
    expect(screen.getByText("第 2 / 2 题")).toBeVisible();
    fireEvent.change(screen.getByLabelText("第二题"), {
      target: { value: "完成" },
    });
    fireEvent.keyDown(screen.getByLabelText("第二题"), { key: "Enter" });
    await flush();
    expect(reply).toHaveBeenCalledWith({ first: "中文答案", second: "完成" });
  });

  it("returns to an earlier required question if a later answer makes it visible", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          {
            key: "detail",
            type: "string",
            title: "先补充说明",
            required: true,
            when: [{ key: "extra", op: "eq", value: true }],
          },
          {
            key: "extra",
            type: "boolean",
            title: "需要补充吗",
            required: true,
            default: false,
          },
        ])}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("需要补充吗"), {
      target: { value: "true" },
    });
    // The current field remains selected by identity even as a preceding field appears.
    expect(screen.getByText("第 2 / 2 题")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    expect(reply).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("请填写先补充说明。");
    expect(screen.getByText("第 1 / 2 题")).toBeVisible();
    fireEvent.change(screen.getByLabelText("先补充说明"), {
      target: { value: "补充内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await flush();
    expect(reply).toHaveBeenCalledWith({ detail: "补充内容", extra: true });
  });

  it("preserves selected and custom multiselect answers when returning to a prior question", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          {
            key: "checks",
            type: "multiselect",
            title: "验证内容",
            custom: true,
            required: true,
            options: [
              {
                value: "unit",
                label: "单元测试",
                description: "覆盖关键逻辑。",
              },
            ],
          },
          { key: "note", type: "string", title: "备注" },
        ])}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "验证内容：单元测试" }),
    );
    fireEvent.change(screen.getByLabelText("验证内容：其他选择"), {
      target: { value: "手动验证" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.click(screen.getByRole("button", { name: "上一题" }));
    expect(
      screen.getByRole("checkbox", { name: "验证内容：单元测试" }),
    ).toBeChecked();
    expect(screen.getByLabelText("验证内容：其他选择")).toHaveValue("手动验证");
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await flush();
    expect(reply).toHaveBeenCalledWith({ checks: ["unit", "手动验证"] });
  });

  it("shows direction descriptions before selection and does not submit a default by itself", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          {
            key: "direction",
            type: "string",
            title: "实现方向",
            required: true,
            default: "small",
            options: [
              {
                value: "small",
                label: "逐步迁移",
                description: "保留现有功能，每步都能验证。",
              },
            ],
          },
        ])}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    const option = screen.getByRole("button", { name: "逐步迁移" });
    expect(screen.getByText("保留现有功能，每步都能验证。")).toBeVisible();
    expect(option).toHaveAccessibleDescription("保留现有功能，每步都能验证。");
    expect(option).toHaveAttribute("aria-pressed", "true");
    await flush();
    expect(reply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await flush();
    expect(reply).toHaveBeenCalledWith({ direction: "small" });
  });

  it("resets the current step and drafts when either the session or question identity changes", () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const first = question([
      { key: "first", type: "string", title: "第一题", default: "初始答案" },
      { key: "second", type: "string", title: "第二题" },
    ]);
    const view = render(
      <AgentQuestionCard question={first} onReply={reply} onReject={vi.fn()} />,
    );
    const moveAndEdit = () => {
      fireEvent.change(screen.getByLabelText("第一题"), {
        target: { value: "旧草稿" },
      });
      fireEvent.click(screen.getByRole("button", { name: "下一题" }));
      expect(screen.getByText("第 2 / 2 题")).toBeVisible();
    };
    moveAndEdit();
    view.rerender(
      <AgentQuestionCard
        question={{ ...first, id: "another-question" }}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("第 1 / 2 题")).toBeVisible();
    expect(screen.getByLabelText("第一题")).toHaveValue("初始答案");
    moveAndEdit();
    view.rerender(
      <AgentQuestionCard
        question={{
          ...first,
          id: "another-question",
          sessionId: "another-session",
        }}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("第 1 / 2 题")).toBeVisible();
    expect(screen.getByLabelText("第一题")).toHaveValue("初始答案");
    expect(reply).not.toHaveBeenCalled();
  });

  it("does not send another answer or rejection after acknowledgement while a stale question is still displayed", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const reject = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          {
            key: "answer",
            type: "string",
            title: "你的回答",
            default: "继续",
          },
        ])}
        onReply={reply}
        onReject={reject}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await flush();
    expect(screen.getByText("答案已提交，等待 Agent 继续。")).toBeVisible();
    expect(screen.getByLabelText("你的回答")).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "选择实现方式" }));
    fireEvent.click(screen.getByRole("button", { name: "取消这次问题" }));
    await flush();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
  });

  it("scopes drafts and in-flight acknowledgements to both the session and question identity", async () => {
    let acknowledge: () => void = () => {};
    const firstReply = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const nextReply = vi.fn().mockResolvedValue(undefined);
    const first = question([
      { key: "answer", type: "string", title: "你的回答", default: "旧答案" },
    ]);
    const view = render(
      <AgentQuestionCard
        question={first}
        onReply={firstReply}
        onReject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    view.rerender(
      <AgentQuestionCard
        question={{
          ...first,
          sessionId: "another-session",
          fields: [
            {
              key: "answer",
              type: "string",
              title: "你的回答",
              default: "新答案",
            },
          ],
        }}
        onReply={nextReply}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("你的回答")).toHaveValue("新答案");
    await act(async () => acknowledge());
    expect(screen.getByRole("button", { name: "提交答案" })).toBeEnabled();
    expect(
      screen.queryByText("答案已提交，等待 Agent 继续。"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await flush();
    expect(nextReply).toHaveBeenCalledWith({ answer: "新答案" });
  });

  it("requires meaningful text and keeps a cancelled question locked after acknowledgement", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const reject = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          {
            key: "answer",
            type: "string",
            title: "你的回答",
            required: true,
          },
        ])}
        onReply={reply}
        onReject={reject}
      />,
    );
    fireEvent.change(screen.getByLabelText("你的回答", { exact: false }), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    expect(reply).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("请填写你的回答。");
    fireEvent.click(screen.getByRole("button", { name: "取消这次问题" }));
    await flush();
    expect(screen.getByText("已取消这次问题，等待 Agent 继续。")).toBeVisible();
    fireEvent.submit(screen.getByRole("form", { name: "选择实现方式" }));
    expect(reply).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(1);
  });

  it("sends selected options, custom answers and multiselect values as real structured answers", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          {
            key: "approach",
            type: "string",
            title: "实现方式",
            required: true,
            custom: true,
            options: [{ value: "simple", label: "简单实现" }],
          },
          {
            key: "checks",
            type: "multiselect",
            title: "验证内容",
            required: true,
            options: [
              { value: "unit", label: "单元测试" },
              { value: "types", label: "类型检查" },
            ],
          },
        ])}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "简单实现" }));
    expect(screen.getByLabelText("实现方式")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("实现方式"), {
      target: { value: "沿用已有组件" },
    });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "验证内容：单元测试" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "验证内容：类型检查" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await flush();
    expect(reply).toHaveBeenCalledWith({
      approach: "沿用已有组件",
      checks: ["unit", "types"],
    });
  });

  it("keeps conditional neq fields hidden until their referenced answer exists and omits inactive answers", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          {
            key: "approach",
            type: "string",
            title: "实现方式",
            options: [
              { value: "simple", label: "简单实现" },
              { value: "custom", label: "自定义实现" },
            ],
            required: true,
          },
          {
            key: "details",
            type: "string",
            title: "补充说明",
            required: true,
            when: [{ key: "approach", op: "neq", value: "simple" }],
          },
        ])}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("补充说明")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "自定义实现" }));
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.change(screen.getByLabelText("补充说明"), {
      target: { value: "只有自定义时生效" },
    });
    fireEvent.click(screen.getByRole("button", { name: "上一题" }));
    fireEvent.click(screen.getByRole("button", { name: "简单实现" }));
    expect(screen.queryByLabelText("补充说明")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await flush();
    expect(reply).toHaveBeenCalledWith({ approach: "simple" });
  });

  it("does not expose hidden fields or use their defaults to activate dependent inputs", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          {
            key: "hidden",
            type: "string",
            title: "内部值",
            hidden: true,
            default: "secret",
          },
          {
            key: "dependent",
            type: "string",
            title: "依赖字段",
            when: [{ key: "hidden", op: "eq", value: "secret" }],
            required: true,
          },
          { key: "answer", type: "string", title: "你的回答", default: "继续" },
        ])}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("内部值")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("依赖字段")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await flush();
    expect(reply).toHaveBeenCalledWith({ answer: "继续" });
  });

  it("validates required answers and numeric bounds without treating false as missing", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          {
            key: "count",
            type: "integer",
            title: "重试次数",
            required: true,
            minimum: 1,
            maximum: 3,
          },
          {
            key: "enabled",
            type: "boolean",
            title: "运行额外检查",
            required: true,
          },
        ])}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    expect(screen.getByText("请填写重试次数。")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("重试次数", { exact: false }), {
      target: { value: 5 },
    });
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    expect(screen.getByText("重试次数超出了允许的范围。")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("重试次数", { exact: false }), {
      target: { value: 2 },
    });
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.change(screen.getByLabelText("运行额外检查", { exact: false }), {
      target: { value: "false" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await flush();
    expect(reply).toHaveBeenCalledWith({ count: 2, enabled: false });
  });

  it("does not fabricate answers to external questions and opens only their real tool URL", async () => {
    const reply = vi.fn();
    const reject = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          {
            key: "external",
            type: "external",
            title: "在工具中完成",
            url: "https://example.test/tool",
          },
        ])}
        onReply={reply}
        onReject={reject}
      />,
    );
    expect(screen.getByRole("button", { name: "提交答案" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "打开工具页面" }));
    await flush();
    expect(settingsApi.openExternal).toHaveBeenCalledWith(
      "https://example.test/tool",
    );
    fireEvent.click(screen.getByRole("button", { name: "取消这次问题" }));
    await flush();
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it("blocks duplicate answers while saving and preserves input when the backend rejects it", async () => {
    let reject: (cause: unknown) => void = () => {};
    const reply = vi.fn().mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    render(
      <AgentQuestionCard
        question={question([
          { key: "answer", type: "string", title: "你的回答", required: true },
        ])}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("你的回答"), {
      target: { value: "保留这个答案" },
    });
    const submit = screen.getByRole("button", { name: "提交答案" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(reply).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("问题状态已变化，请重试。")));
    expect(screen.getByText("问题状态已变化，请重试。")).toBeInTheDocument();
    expect(screen.getByLabelText("你的回答")).toHaveValue("保留这个答案");
    expect(screen.getByRole("button", { name: "提交答案" })).toBeEnabled();
  });

  it("requires every visibility condition and validates multiselect limits", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          { key: "first", type: "boolean", title: "条件一", default: true },
          { key: "second", type: "boolean", title: "条件二", default: false },
          {
            key: "checks",
            type: "multiselect",
            title: "验证",
            required: true,
            maxItems: 1,
            when: [
              { key: "first", op: "eq", value: true },
              { key: "second", op: "eq", value: true },
            ],
            options: [
              { value: "one", label: "第一项" },
              { value: "two", label: "第二项" },
            ],
          },
        ])}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.change(screen.getByLabelText("条件二"), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "验证：第一项" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "验证：第二项" }));
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    expect(screen.getByText("验证的选项数量不符合要求。")).toBeInTheDocument();
    expect(reply).not.toHaveBeenCalled();
  });

  it("uses membership rather than array equality for conditions on a multiselect answer", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionCard
        question={question([
          {
            key: "checks",
            type: "multiselect",
            title: "验证内容",
            options: [
              { value: "unit", label: "单元测试" },
              { value: "types", label: "类型检查" },
            ],
          },
          {
            key: "testCommand",
            type: "string",
            title: "测试命令",
            required: true,
            when: [{ key: "checks", op: "eq", value: "unit" }],
          },
        ])}
        onReply={reply}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("测试命令")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "验证内容：单元测试" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.change(screen.getByLabelText("测试命令"), {
      target: { value: "pnpm test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await flush();
    expect(reply).toHaveBeenCalledWith({
      checks: ["unit"],
      testCommand: "pnpm test",
    });
  });
});
