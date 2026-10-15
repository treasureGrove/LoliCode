import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentModelPicker } from "@/components/agent/AgentModelPicker";
import type { AgentModel } from "@/types/agent";

const models: AgentModel[] = [
  {
    id: "opaque/a/model/one",
    providerId: "shared",
    modelId: "model/one",
    name: "Code One",
    channelName: "Channel A",
  },
  {
    id: "opaque/b/model/two",
    providerId: "shared",
    modelId: "model/two",
    name: "Code Two",
    channelName: "Channel B",
  },
];

describe("AgentModelPicker", () => {
  it("opens the selected channel and lets each channel collapse independently", () => {
    render(
      <AgentModelPicker
        models={models}
        value={models[0].id}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    const current = screen.getByRole("button", { name: "Channel A 模型" });
    const other = screen.getByRole("button", { name: "Channel B 模型" });
    expect(current).toHaveAttribute("aria-expanded", "true");
    expect(other).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Channel A · Code One" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("button", { name: "Channel B · Code Two" }),
    ).not.toBeInTheDocument();
    fireEvent.click(other);
    expect(
      screen.getByRole("button", { name: "Channel B · Code Two" }),
    ).toBeVisible();
    fireEvent.click(current);
    expect(
      screen.queryByRole("button", { name: "Channel A · Code One" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Channel B · Code Two" }),
    ).toBeVisible();
  });

  it("searches model IDs and selects the exact opaque catalog ID without submitting a message", () => {
    const select = vi.fn(),
      submit = vi.fn();
    render(
      <form onSubmit={submit}>
        <AgentModelPicker
          models={models}
          value={models[0].id}
          onSelect={select}
        />
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "搜索模型或渠道" }),
      { target: { value: "model/two" } },
    );
    expect(
      screen.queryByRole("button", { name: "Channel A 模型" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Channel B · Code Two" }),
    );
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith(models[1].id);
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("searches channels and reports no match without hiding the current selection", () => {
    render(
      <AgentModelPicker
        models={models}
        value={models[0].id}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    const input = screen.getByRole("searchbox", { name: "搜索模型或渠道" });
    fireEvent.change(input, { target: { value: "channel b" } });
    expect(
      screen.getByRole("button", { name: "Channel B · Code Two" }),
    ).toBeVisible();
    fireEvent.change(input, { target: { value: "missing" } });
    expect(screen.getByRole("status")).toHaveTextContent("没有匹配的模型");
    expect(screen.getByRole("button", { name: "模型" })).toHaveTextContent(
      "Code One",
    );
  });

  it("does not open or mutate a read-only picker", () => {
    const select = vi.fn();
    render(
      <AgentModelPicker
        models={models}
        value={models[0].id}
        onSelect={select}
        disabled
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(select).not.toHaveBeenCalled();
  });

  it("stays closed after a temporary configuration lock or catalog refresh", () => {
    const select = vi.fn();
    const view = render(
      <AgentModelPicker
        models={models}
        value={models[0].id}
        onSelect={select}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(
      <AgentModelPicker
        models={models}
        value={models[0].id}
        onSelect={select}
        disabled
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(
      <AgentModelPicker
        models={models}
        value={models[0].id}
        onSelect={select}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(select).not.toHaveBeenCalled();
  });

  it("shows an unavailable binding without silently selecting another model", () => {
    const select = vi.fn();
    render(
      <AgentModelPicker
        models={models}
        value="removed"
        unavailableLabel="旧模型（目录中不可用）"
        onSelect={select}
      />,
    );
    expect(screen.getByRole("button", { name: "模型" })).toHaveTextContent(
      "旧模型（目录中不可用）",
    );
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(
      screen.getByRole("button", { name: "Channel A 模型" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});
