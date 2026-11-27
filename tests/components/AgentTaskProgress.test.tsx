import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentTaskProgress } from "@/features/agent/AgentTaskProgress";
import { agentApi } from "@/lib/api/agent";
import type { AgentNativeSessionRead } from "@/types/harness-session";

vi.mock("@/lib/api/agent", () => ({
  agentApi: {
    readSessionNative: vi.fn(),
    watchSessionNative: vi.fn(),
    stopSessionNative: vi.fn(),
  },
}));
vi.mock("@/features/sessions/reader/SessionMarkdown", () => ({
  SessionMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

const catalog = {
  kind: "sequenced",
  asOfSeq: 15,
  values: {
    subagentCatalog: [
      {
        id: "child",
        createdAt: 1,
        label: "Inspect the candidate",
        mode: "one-shot",
      },
      {
        id: "external",
        createdAt: 2,
        label: "External worker",
        mode: "external",
      },
    ],
  },
} satisfies Extract<
  AgentNativeSessionRead["projections"],
  { kind: "sequenced" }
>;
const emptyProjections = {
  kind: "sequenced",
  asOfSeq: 11,
  values: {},
} as const;
const state = {
  active: false,
  running: false,
  pendingInput: [],
  queue: null,
  cursor: 15,
};
const childRead: AgentNativeSessionRead = {
  page: {
    cursor: 4,
    hasMore: false,
    records: [
      {
        type: "event",
        event: {
          seq: 4,
          time: 5,
          type: "assistant/message",
          surfaceOp: "append",
          data: {
            turn: 1,
            step: 1,
            message: {
              id: "reply",
              role: "assistant",
              content: [{ type: "text", text: "Child transcript marker" }],
            },
          },
        },
      },
    ],
  },
  projections: null,
  state,
};
const props = {
  active: true,
  rootSessionId: "lc:root",
  projectPath: "D:/fixture",
  showProgress: false,
  progressId: "inline-progress",
  onJumpToProgress: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentApi.readSessionNative).mockReset();
  vi.mocked(agentApi.watchSessionNative).mockReset().mockResolvedValue(false);
  vi.mocked(agentApi.stopSessionNative).mockReset().mockResolvedValue();
});

it("preserves the inline progress shortcut when there are no child sessions", () => {
  render(
    <AgentTaskProgress
      {...props}
      showProgress
      projections={emptyProjections}
    />,
  );
  const progress = screen.getByRole("button", { name: "任务进度" });
  expect(progress).toHaveAttribute("aria-controls", "inline-progress");
  fireEvent.click(progress);
  expect(props.onJumpToProgress).toHaveBeenCalledOnce();
  expect(agentApi.readSessionNative).not.toHaveBeenCalled();
});

it("opens only a selected local child's read-only history and scopes the live watch to its root", async () => {
  const user = userEvent.setup();
  vi.mocked(agentApi.readSessionNative).mockResolvedValue(childRead);
  vi.mocked(agentApi.watchSessionNative).mockReturnValue(new Promise(() => {}));
  render(<AgentTaskProgress {...props} projections={catalog} />);
  await user.click(screen.getByRole("button", { name: "任务进度" }));
  const dialog = screen.getByRole("dialog", { name: "子代理会话" });
  expect(
    within(dialog).getByRole("button", { name: "External worker" }),
  ).toBeDisabled();
  expect(agentApi.readSessionNative).not.toHaveBeenCalled();
  await user.click(
    within(dialog).getByRole("button", { name: "Inspect the candidate" }),
  );
  expect(
    await within(dialog).findByText("Child transcript marker"),
  ).toBeInTheDocument();
  expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
  expect(agentApi.readSessionNative).toHaveBeenCalledWith("lc:child", {
    rootSessionId: "lc:root",
    maxMessages: 12,
  });
  const [id, subscription, , options] = vi.mocked(agentApi.watchSessionNative)
    .mock.calls[0];
  expect([id, options]).toEqual([
    "lc:child",
    { maxMessages: 12, rootSessionId: "lc:root" },
  ]);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(agentApi.stopSessionNative).toHaveBeenCalledWith(subscription);
  expect(screen.getByRole("button", { name: "任务进度" })).toHaveFocus();
});

it("reloads the official catalog after a live catalog event and ignores a retired root's result", async () => {
  const user = userEvent.setup();
  let accept!: (read: AgentNativeSessionRead) => void;
  vi.mocked(agentApi.readSessionNative)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        accept = resolve;
      }),
    )
    .mockResolvedValueOnce({ ...childRead, projections: catalog });
  const view = render(
    <AgentTaskProgress
      {...props}
      projections={emptyProjections}
      catalogEventSeq={13}
    />,
  );
  expect(agentApi.readSessionNative).toHaveBeenCalledWith("lc:root", {
    maxMessages: 1,
  });
  view.rerender(
    <AgentTaskProgress
      {...props}
      rootSessionId="lc:second"
      projections={emptyProjections}
      catalogEventSeq={15}
    />,
  );
  expect(agentApi.readSessionNative).toHaveBeenLastCalledWith("lc:second", {
    maxMessages: 1,
  });
  await act(async () =>
    accept({
      ...childRead,
      projections: {
        ...catalog,
        values: {
          subagentCatalog: [
            { id: "old", label: "Retired child", mode: "one-shot" },
          ],
        },
      },
    }),
  );
  await user.click(screen.getByRole("button", { name: "任务进度" }));
  expect(
    screen.getByRole("button", { name: "Inspect the candidate" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retired child" }),
  ).not.toBeInTheDocument();
});
