import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentQuestionCard } from "@/components/agent/AgentQuestionCard";
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
    fireEvent.change(screen.getByLabelText("实现方式"), {
      target: { value: "沿用已有组件" },
    });
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
    fireEvent.change(screen.getByLabelText("补充说明"), {
      target: { value: "只有自定义时生效" },
    });
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
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    expect(screen.getByText("请填写重试次数。")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("重试次数", { exact: false }), {
      target: { value: 5 },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    expect(screen.getByText("重试次数超出了允许的范围。")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("重试次数", { exact: false }), {
      target: { value: 2 },
    });
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
    fireEvent.change(screen.getByLabelText("条件二"), {
      target: { value: "true" },
    });
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
