import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentNativeSessionPreview } from "@/features/agent/AgentNativeSessionPreview";
import { agentApi } from "@/lib/api/agent";
import type { AgentNativeSessionRead } from "@/types/harness-session";

vi.mock("@/lib/api/agent", () => ({
  agentApi: { readSessionNative: vi.fn() },
}));
beforeEach(() => {
  vi.mocked(agentApi.readSessionNative).mockReset();
});
afterEach(cleanup);

it("renders committed conversation and terminal reason while retaining unknown events", async () => {
  const reply: AgentNativeSessionRead = {
    page: {
      cursor: 4,
      hasMore: false,
      records: [
        {
          type: "event",
          event: {
            seq: 0,
            time: 1,
            type: "user/message",
            data: {
              source: { kind: "user" },
              content: [{ type: "text", text: "请检查项目" }],
            },
          },
        },
        {
          type: "event",
          event: {
            seq: 1,
            time: 2,
            type: "assistant/message",
            data: {
              turn: 1,
              step: 1,
              message: { content: [{ type: "text", text: "已检查代码" }] },
            },
          },
        },
        {
          type: "event",
          event: {
            seq: 2,
            time: 3,
            type: "turn/end",
            data: { turn: 1, reason: { kind: "max-tokens" } },
          },
        },
        {
          type: "event",
          event: {
            seq: 3,
            time: 4,
            type: "plugin:fixture/state",
            ignorable: true,
            data: { retained: true },
          },
        },
        {
          type: "event",
          event: {
            seq: 4,
            time: 5,
            type: "system/message",
            data: {
              message: {
                content: [{ type: "text", text: "private-system-context" }],
              },
            },
          },
        },
      ],
    },
    projections: { kind: "sequenced", asOfSeq: 6, values: {} },
    state: {
      cursor: 6,
      active: false,
      running: false,
      queue: null,
      pendingInput: [],
    },
  };
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(reply);
  render(
    <AgentNativeSessionPreview
      open
      onOpenChange={vi.fn()}
      sessionId="lc:first"
      title="代码检查"
    />,
  );
  await act(async () => {});
  expect(screen.getByText("请检查项目")).toBeInTheDocument();
  expect(screen.getByText("已检查代码")).toBeInTheDocument();
  expect(screen.getByText("第 1 轮 · 达到输出上限")).toBeInTheDocument();
  expect(screen.getByText("其他会话事件")).toBeInTheDocument();
  expect(screen.queryByText("private-system-context")).not.toBeInTheDocument();
  expect(
    screen.getByRole("list", { name: "原生会话记录" }).children,
  ).toHaveLength(5);
  fireEvent.click(screen.getByRole("button", { name: "刷新原生会话" }));
  await act(async () => {});
  expect(agentApi.readSessionNative).toHaveBeenCalledTimes(2);
});

it("keeps the experiment passive while its dialog is closed", async () => {
  render(
    <AgentNativeSessionPreview
      open={false}
      onOpenChange={vi.fn()}
      sessionId="lc:first"
    />,
  );
  await act(async () => {});
  expect(agentApi.readSessionNative).not.toHaveBeenCalled();
});
