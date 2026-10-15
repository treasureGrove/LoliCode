import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentReasoningPicker } from "@/components/agent/AgentReasoningPicker";
import type { AgentModel } from "@/types/agent";

const model: AgentModel = {
  id: "opaque/model",
  providerId: "channel",
  modelId: "model/real-id",
  name: "Model",
  channelName: "Channel",
  contextLimit: 131072,
  outputLimit: 32768,
  reasoningEfforts: ["low", "high", "channel_special-2"],
};

const open = () =>
  fireEvent.click(screen.getByRole("button", { name: "思考档位" }));

describe("AgentReasoningPicker", () => {
  it("uses declared effort IDs and exact catalog limits without inventing choices or submitting the parent form", () => {
    const select = vi.fn(),
      submit = vi.fn();
    render(
      <form onSubmit={submit}>
        <AgentReasoningPicker model={model} value="low" onSelect={select} />
      </form>,
    );
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "思考档位" })).toHaveTextContent(
      "low",
    );
    open();
    expect(screen.getByText("131,072 tokens")).toBeVisible();
    expect(screen.getByText("32,768 tokens")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "思考档位 low" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("button", { name: "思考档位 medium" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "思考档位 channel_special-2" }),
    );
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith("channel_special-2");
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The acknowledged value belongs to the parent; a failed update keeps low.
    expect(screen.getByRole("button", { name: "思考档位" })).toHaveTextContent(
      "low",
    );
  });

  it.each([undefined, null])(
    "allows an explicit manual value only when effort metadata is %s",
    (reasoningEfforts) => {
      const select = vi.fn(),
        submit = vi.fn();
      render(
        <form onSubmit={submit}>
          <AgentReasoningPicker
            model={{
              ...model,
              reasoningEfforts,
              contextLimit: null,
              outputLimit: undefined,
            }}
            value=""
            onSelect={select}
          />
        </form>,
      );
      expect(select).not.toHaveBeenCalled();
      open();
      expect(screen.getAllByText("未知（渠道未提供）")).toHaveLength(2);
      const input = screen.getByRole("textbox", {
        name: "手动档位标识（未验证）",
      });
      fireEvent.change(input, { target: { value: "custom_v2-high" } });
      expect(select).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(select).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "应用手动档位" }));
      expect(select).toHaveBeenCalledOnce();
      expect(select).toHaveBeenCalledWith("custom_v2-high");
      expect(submit).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("does not invent effort options or allow manual overrides when the model explicitly declares none", () => {
    const select = vi.fn();
    render(
      <AgentReasoningPicker
        model={{ ...model, reasoningEfforts: [] }}
        value=""
        onSelect={select}
      />,
    );
    open();
    expect(screen.getByText("当前模型已声明没有可选思考档位。")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "思考档位 high" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "使用上游默认" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(select).not.toHaveBeenCalled();
  });

  it.each(["bad value", "中文", "a.b", "a/b", "x".repeat(65)])(
    "rejects invalid manual identifier %s",
    (value) => {
      const select = vi.fn();
      render(
        <AgentReasoningPicker
          model={{ ...model, reasoningEfforts: undefined }}
          value=""
          onSelect={select}
        />,
      );
      open();
      const input = screen.getByRole("textbox", {
        name: "手动档位标识（未验证）",
      });
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveAttribute("aria-invalid", "true");
      const apply = screen.getByRole("button", { name: "应用手动档位" });
      expect(apply).toBeDisabled();
      fireEvent.click(apply);
      expect(select).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "declared efforts", reasoningEfforts: model.reasoningEfforts },
    { label: "unknown efforts", reasoningEfforts: undefined },
    { label: "no efforts", reasoningEfforts: [] },
  ])(
    "restores the upstream default explicitly for $label",
    ({ reasoningEfforts }) => {
      const select = vi.fn();
      render(
        <AgentReasoningPicker
          model={{ ...model, reasoningEfforts }}
          value="high"
          onSelect={select}
        />,
      );
      open();
      fireEvent.click(screen.getByRole("button", { name: "使用上游默认" }));
      expect(select).toHaveBeenCalledOnce();
      expect(select).toHaveBeenCalledWith("");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("can apply an empty manual value to restore the upstream default", () => {
    const select = vi.fn();
    render(<AgentReasoningPicker value="custom" onSelect={select} />);
    open();
    const input = screen.getByRole("textbox", {
      name: "手动档位标识（未验证）",
    });
    expect(input).toHaveValue("custom");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "应用手动档位" }));
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith("");
  });

  it("stays closed after a temporary disabled state and never applies a draft automatically", () => {
    const select = vi.fn();
    const view = render(
      <AgentReasoningPicker value="manual" onSelect={select} />,
    );
    open();
    fireEvent.change(
      screen.getByRole("textbox", { name: "手动档位标识（未验证）" }),
      { target: { value: "draft" } },
    );
    view.rerender(
      <AgentReasoningPicker value="manual" onSelect={select} disabled />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "思考档位" })).toBeDisabled();
    open();
    expect(select).not.toHaveBeenCalled();
    view.rerender(<AgentReasoningPicker value="manual" onSelect={select} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    open();
    expect(
      screen.getByRole("textbox", { name: "手动档位标识（未验证）" }),
    ).toHaveValue("manual");
    expect(select).not.toHaveBeenCalled();
  });

  it.each([
    {
      transport: "declared" as const,
      source: "渠道模型目录 reasoning_efforts",
      label: "中转声明支持此参数",
    },
    {
      transport: "unconfirmed" as const,
      source: "上游模型资料：deepseek/deepseek-v4-pro",
      label: "中转尚未声明此参数的兼容性",
    },
    {
      transport: "mixed" as const,
      source: "同模型的多个真实渠道映射",
      label: "存在多路由差异，自动档位取可确认交集",
    },
  ])(
    "shows actual effort provenance and $transport compatibility without treating it as verification",
    ({ transport, source, label }) => {
      const select = vi.fn();
      render(
        <AgentReasoningPicker
          model={{
            ...model,
            reasoningEffortSource: source,
            reasoningEffortTransport: transport,
          }}
          value=""
          onSelect={select}
        />,
      );
      open();
      expect(screen.getByText(source)).toBeVisible();
      expect(screen.getByText(label)).toBeVisible();
      expect(screen.queryByText(/已验证/)).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "思考档位 high" }));
      expect(select).toHaveBeenCalledOnce();
      expect(select).toHaveBeenCalledWith("high");
    },
  );
});
