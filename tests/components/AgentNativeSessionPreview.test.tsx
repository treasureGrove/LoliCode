import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionWireHeader } from "@deepseek-ai/dsh-api-session-controller/types";
import { AgentNativeSessionPreview } from "@/features/agent/AgentNativeSessionPreview";
import { agentApi } from "@/lib/api/agent";
import type {
  AgentNativeSessionRead,
  AgentNativeSessionWatchMessage,
} from "@/types/harness-session";

vi.mock("@/lib/api/agent", () => ({
  agentApi: {
    readSessionNative: vi.fn(),
    watchSessionNative: vi.fn(),
    stopSessionNative: vi.fn(),
  },
}));
beforeEach(() => {
  vi.mocked(agentApi.readSessionNative).mockReset();
  vi.mocked(agentApi.watchSessionNative).mockReset().mockResolvedValue(false);
  vi.mocked(agentApi.stopSessionNative)
    .mockReset()
    .mockResolvedValue(undefined);
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

it("renders committed updates live and enables backward paging only after pausing", async () => {
  const record: AgentNativeSessionRead["page"]["records"][number] = {
    type: "event",
    event: {
      seq: 3,
      time: 1,
      type: "user/message",
      data: {
        content: [{ type: "text", text: "等待新的结果" }],
      },
    },
  };
  const reply: AgentNativeSessionRead = {
    page: { cursor: 3, records: [record], hasMore: true },
    projections: { kind: "sequenced", asOfSeq: 3, values: {} },
    state: {
      cursor: 3,
      active: true,
      running: true,
      queue: null,
      pendingInput: [],
    },
  };
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(reply);
  let receive!: (message: AgentNativeSessionWatchMessage) => void;
  let subscriptionId!: string;
  vi.mocked(agentApi.watchSessionNative).mockImplementation(
    (_id, id, accept) => {
      subscriptionId = id;
      receive = accept;
      return new Promise<boolean>(() => {});
    },
  );
  render(
    <AgentNativeSessionPreview
      open
      onOpenChange={vi.fn()}
      sessionId="lc:first"
    />,
  );
  await act(async () => {});
  act(() => {
    receive({
      subscriptionId,
      frame: {
        type: "snapshot",
        header: {
          version: 4,
          id: "first" as SessionWireHeader["id"],
          createdAt: 1,
          isSeeded: false,
        },
        records: [record],
        cursor: 3,
        hasMore: true,
        projections: { asOfSeq: 3, values: {} },
      },
    });
    receive({
      subscriptionId,
      frame: {
        type: "event",
        event: {
          seq: 4,
          time: 2,
          type: "assistant/message",
          data: {
            turn: 1,
            step: 1,
            message: {
              content: [{ type: "text", text: "实时收到已提交结果" }],
            },
          },
        },
      },
    });
  });
  expect(screen.getByText("实时收到已提交结果")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("实时跟随已提交记录");
  expect(screen.getByRole("button", { name: "加载更早记录" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "暂停实时更新" }));
  expect(screen.getByRole("button", { name: "加载更早记录" })).toBeEnabled();
  expect(agentApi.stopSessionNative).toHaveBeenCalledWith(subscriptionId);
});
