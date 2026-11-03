import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AgentMessageQueue,
  type AgentMessageQueueProps,
} from "@/features/agent/AgentMessageQueue";

const props = (
  patch: Partial<AgentMessageQueueProps> = {},
): AgentMessageQueueProps => ({
  items: [
    { id: "first", text: "先检查实现" },
    {
      id: "second",
      text: "再看这两个附件",
      attachments: [
        { fileName: "参考图.png", mime: "image/png", bytes: 1024 },
        { fileName: "说明.pdf", mime: "application/pdf", bytes: 2048 },
      ],
    },
  ],
  onSendNow: vi.fn(),
  onRecall: vi.fn(),
  onRemove: vi.fn(),
  ...patch,
});
async function openMore(ordinal: number) {
  fireEvent.keyDown(
    screen.getByRole("button", { name: `第 ${ordinal} 条消息的更多操作` }),
    { key: "Enter" },
  );
  return screen.findByRole("menuitem", {
    name: `撤回编辑第 ${ordinal} 条消息`,
  });
}

describe("AgentMessageQueue", () => {
  it("does not render an empty queue", () => {
    const view = render(<AgentMessageQueue {...props({ items: [] })} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("shows messages in order, attachment names and their count", () => {
    render(<AgentMessageQueue {...props()} />);
    expect(
      screen.getByRole("heading", { name: "待发送 · 2" }).closest("header"),
    ).toHaveClass("sr-only");
    expect(screen.getByRole("status")).toHaveTextContent(
      "当前回复结束后依次发送",
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("先检查实现")).toBeVisible();
    expect(within(items[1]).getByText("再看这两个附件")).toBeVisible();
    expect(
      within(items[1]).getByLabelText("2 个附件 · 参考图.png、说明.pdf"),
    ).toHaveAttribute("title", "参考图.png、说明.pdf");
    expect(
      screen.queryByRole("button", { name: /撤回编辑/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("routes direct actions and the recall menu item to the correct stable message id", async () => {
    const callbacks = props();
    render(<AgentMessageQueue {...callbacks} />);
    fireEvent.click(
      screen.getByRole("button", { name: "立即发送第 2 条消息" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "删除第 2 条消息" }));
    fireEvent.click(await openMore(1));
    expect(callbacks.onSendNow).toHaveBeenCalledOnce();
    expect(callbacks.onSendNow).toHaveBeenCalledWith("second");
    expect(callbacks.onRecall).toHaveBeenCalledOnce();
    expect(callbacks.onRecall).toHaveBeenCalledWith("first");
    expect(callbacks.onRemove).toHaveBeenCalledOnce();
    expect(callbacks.onRemove).toHaveBeenCalledWith("second");
  });

  it("opens full message and attachment details from the menu and recalls with the keyboard", async () => {
    const callbacks = props();
    render(<AgentMessageQueue {...callbacks} />);
    const trigger = screen.getByRole("button", {
      name: "第 2 条消息的更多操作",
    });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const recall = await screen.findByRole("menuitem", {
      name: "撤回编辑第 2 条消息",
    });
    expect(screen.getByRole("menu")).toHaveTextContent("再看这两个附件");
    expect(screen.getByRole("menu")).toHaveTextContent("参考图.png、说明.pdf");
    recall.focus();
    await userEvent.keyboard("{Enter}");
    expect(callbacks.onRecall).toHaveBeenCalledOnce();
    expect(callbacks.onRecall).toHaveBeenCalledWith("second");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("disables an already-open recall menu when another queued message becomes busy", async () => {
    const callbacks = props();
    const view = render(<AgentMessageQueue {...callbacks} />);
    await openMore(1);
    view.rerender(<AgentMessageQueue {...callbacks} busyId="second" />);
    const recall = screen.getByRole("menuitem", {
      name: "撤回编辑第 1 条消息",
    });
    expect(recall).toHaveAttribute("data-disabled");
    fireEvent.click(recall);
    expect(callbacks.onRecall).not.toHaveBeenCalled();
  });

  it("keeps manual actions available when automatic sending is paused", async () => {
    const callbacks = props({ paused: true });
    render(<AgentMessageQueue {...callbacks} />);
    expect(screen.getByRole("status")).toHaveTextContent("队列已暂停");
    const send = screen.getByRole("button", { name: "立即发送第 1 条消息" });
    send.focus();
    await userEvent.keyboard("{Enter}");
    expect(callbacks.onSendNow).toHaveBeenCalledOnce();
    expect(callbacks.onSendNow).toHaveBeenCalledWith("first");
  });

  it.each([{ busyId: "second" }, { disabled: true }])(
    "blocks mutations while a message is being submitted or the queue is disabled: %o",
    (patch) => {
      const callbacks = props(patch);
      render(<AgentMessageQueue {...callbacks} />);
      for (const button of screen.getAllByRole("button")) {
        expect(button).toBeDisabled();
        fireEvent.click(button);
      }
      expect(callbacks.onSendNow).not.toHaveBeenCalled();
      expect(callbacks.onRecall).not.toHaveBeenCalled();
      expect(callbacks.onRemove).not.toHaveBeenCalled();
      if (patch.busyId) {
        expect(screen.getAllByRole("listitem")[1]).toHaveAttribute(
          "aria-busy",
          "true",
        );
        expect(
          screen.getByRole("button", { name: "正在发送第 2 条消息" }),
        ).toHaveTextContent("发送中");
      }
    },
  );

  it("labels attachment-only messages without treating their text as markup", () => {
    const value = props();
    value.items[0].text = "<img src=x onerror=alert(1)>";
    value.items[1].text = "";
    render(<AgentMessageQueue {...value} />);
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
    expect(screen.getByText("仅附件消息")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
