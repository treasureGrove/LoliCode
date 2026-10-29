import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentContextPicker } from "@/features/agent/AgentContextPicker";
import type { AgentModel } from "@/types/agent";

const model: AgentModel = {
  id: "opaque/model",
  providerId: "channel",
  modelId: "model/real-id",
  name: "Model",
  channelName: "Channel",
  contextLimit: 272000,
};
const open = () =>
  fireEvent.click(screen.getByRole("button", { name: "上下文窗口" }));

describe("AgentContextPicker", () => {
  it("offers only exact declared windows when the upstream supplies explicit tiers", () => {
    const select = vi.fn(),
      submit = vi.fn();
    render(
      <form onSubmit={submit}>
        <AgentContextPicker
          model={{
            ...model,
            contextLimits: [
              922000,
              128000,
              922000,
              0,
              -1,
              1.5,
              Infinity,
              Number.MAX_SAFE_INTEGER + 1,
            ],
          }}
          onSelect={select}
        />
      </form>,
    );
    expect(select).not.toHaveBeenCalled();
    open();
    const options = screen.getAllByRole("button", {
      name: /^上下文窗口 [\d,]+ tokens$/,
    });
    expect(options.map((button) => button.textContent)).toEqual([
      "128,000 tokens",
      "922,000 tokens",
    ]);
    expect(
      screen.queryByRole("button", { name: /1,050,000/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "上下文窗口 922,000 tokens" }),
    );
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith(922000);
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The parent only changes the saved value after backend acknowledgement.
    expect(
      screen.getByRole("button", { name: "上下文窗口" }),
    ).toHaveTextContent("272K");
  });

  it("inherits the smallest declared window when only array metadata is available", () => {
    render(
      <AgentContextPicker
        model={{
          ...model,
          contextLimit: null,
          contextLimits: [256000, 0, 128000],
        }}
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "上下文窗口" }),
    ).toHaveTextContent("128K");
    open();
    expect(
      screen.getByRole("button", { name: "使用默认上下文" }),
    ).toHaveTextContent("128,000 tokens");
    expect(screen.queryByText(/1,000,000|1M/)).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /^上下文窗口 [\d,]+ tokens$/ }),
    ).toHaveLength(2);
  });

  it.each([undefined, null, 0, -1, Infinity])(
    "always shows the 1M fallback when no context metadata exists (%s)",
    (contextLimit) => {
      const select = vi.fn();
      render(
        <AgentContextPicker
          model={{ ...model, contextLimit }}
          onSelect={select}
        />,
      );
      expect(
        screen.getByRole("button", { name: "上下文窗口" }),
      ).toHaveTextContent("上下文 · 1M");
      open();
      expect(
        screen.getByText("上游未提供上下文信息，默认使用 1M 本地预算。"),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "使用默认上下文" }),
      ).toHaveTextContent("1,000,000 tokens");
      expect(
        screen.getByText("本地上下文预算，不更改上游模型参数。"),
      ).toBeVisible();
      expect(select).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("button", { name: "上下文窗口 256,000 tokens" }),
      );
      expect(select).toHaveBeenLastCalledWith(256000);
      open();
      fireEvent.click(screen.getByRole("button", { name: "使用默认上下文" }));
      expect(select).toHaveBeenCalledTimes(2);
      expect(select).toHaveBeenLastCalledWith(null);
    },
  );

  it.each([
    {
      limit: 1000000,
      expected: [256000, 1000000],
    },
    { limit: 272000, expected: [256000, 272000] },
    { limit: 128000, expected: [128000] },
    { limit: 16000, expected: [16000] },
  ])(
    "offers bounded local choices for scalar-only metadata $limit",
    ({ limit, expected }) => {
      const select = vi.fn();
      render(
        <AgentContextPicker
          model={{ ...model, contextLimit: limit }}
          onSelect={select}
        />,
      );
      open();
      expect(
        screen.getByText("本地上下文预算，不更改上游模型参数。"),
      ).toBeVisible();
      expect(
        screen.queryByText("上游提供的上下文档位"),
      ).not.toBeInTheDocument();
      expect(
        screen
          .getAllByRole("button", { name: /^上下文窗口 [\d,]+ tokens$/ })
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(
        expected.map(
          (value) => `上下文窗口 ${value.toLocaleString("zh-CN")} tokens`,
        ),
      );
      const selected = expected.includes(256000) ? 256000 : limit;
      fireEvent.click(
        screen.getByRole("button", {
          name: `上下文窗口 ${selected.toLocaleString("zh-CN")} tokens`,
        }),
      );
      expect(select).toHaveBeenCalledOnce();
      expect(select).toHaveBeenCalledWith(selected);
    },
  );

  it.each([32000, 64000, 128000, 512000])(
    "keeps an older saved %s budget visible and lets the user switch it",
    (saved) => {
      const select = vi.fn();
      render(
        <AgentContextPicker
          model={{ ...model, contextLimit: 1000000 }}
          value={saved}
          onSelect={select}
        />,
      );
      expect(
        screen.getByRole("button", { name: "上下文窗口" }),
      ).toHaveAttribute(
        "title",
        `当前上下文：${saved.toLocaleString("zh-CN")} tokens`,
      );
      expect(select).not.toHaveBeenCalled();
      open();
      expect(screen.getByText(/已不在当前可选预算中/)).toBeVisible();
      expect(
        screen
          .getAllByRole("button", { name: /^上下文窗口 [\d,]+ tokens$/ })
          .map((button) => button.textContent),
      ).toEqual(["256,000 tokens", "1,000,000 tokens"]);
      fireEvent.click(
        screen.getByRole("button", { name: "上下文窗口 256,000 tokens" }),
      );
      expect(select).toHaveBeenCalledOnce();
      expect(select).toHaveBeenCalledWith(256000);
    },
  );

  it("preserves a saved window removed from the catalog and can restore inheritance", () => {
    const select = vi.fn();
    render(
      <AgentContextPicker model={model} value={1000000} onSelect={select} />,
    );
    expect(
      screen.getByRole("button", { name: "上下文窗口" }),
    ).toHaveTextContent("1M");
    open();
    expect(screen.getByText(/已不在当前可选预算中/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "上下文窗口 1,000,000 tokens" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "使用默认上下文" }));
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith(null);
  });

  it("distinguishes the selected 1M context budget from a 128 KiB entry request limit", () => {
    render(
      <AgentContextPicker
        model={{
          ...model,
          contextLimits: [1000000],
          maxRequestBytes: 128 * 1024,
        }}
        value={1000000}
        onSelect={vi.fn()}
      />,
    );
    open();
    expect(screen.getByText("当前上下文：1,000,000 tokens")).toBeVisible();
    expect(screen.getByTitle("131,072 字节")).toHaveTextContent(
      "入口请求体上限：128 KiB",
    );
    expect(screen.getByTitle("131,072 字节")).toHaveTextContent(
      "上下文是本地预算，仍需遵守入口的请求大小限制",
    );
    expect(
      screen.getByRole("button", { name: "上下文窗口 1,000,000 tokens" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("closes when disabled or changing models and never submits a selection automatically", () => {
    const select = vi.fn();
    const view = render(<AgentContextPicker model={model} onSelect={select} />);
    open();
    view.rerender(
      <AgentContextPicker model={model} onSelect={select} disabled />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上下文窗口" })).toBeDisabled();
    view.rerender(<AgentContextPicker model={model} onSelect={select} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    open();
    view.rerender(
      <AgentContextPicker
        model={{ ...model, id: "other/model" }}
        onSelect={select}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(select).not.toHaveBeenCalled();
  });
});
