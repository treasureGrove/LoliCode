import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AgentNativeTranscript,
  hasNativeTranscriptContent,
} from "@/features/agent/AgentNativeTranscript";
import type {
  SessionAssistantStreamAttempt,
  SessionWireEvent,
} from "@/types/harness-session";

vi.mock("@/features/sessions/reader/SessionMarkdown", () => ({
  SessionMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

const event = (
  seq: number,
  type: string,
  data: unknown,
  surfaceOp?: unknown,
): SessionWireEvent => ({
  seq,
  type,
  time: seq + 1,
  data: data as SessionWireEvent["data"],
  ...([
    "user/message",
    "assistant/message",
    "tool/result",
    "system/message",
  ].includes(type)
    ? { surfaceOp: (surfaceOp ?? "append") as SessionWireEvent["surfaceOp"] }
    : {}),
});
const user = (seq: number, content = `Question ${seq}`) =>
  event(seq, "user/message", {
    id: `user-${seq}`,
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: content }],
  });
const assistant = (seq: number, turn: number, content: unknown[]) =>
  event(seq, "assistant/message", {
    turn,
    step: 1,
    message: { id: `assistant-${seq}`, role: "assistant", content },
    stream: [],
  });
const tool = (id = "same-call") => ({
  type: "tool-call",
  id,
  name: "write_file",
  arguments: '{"path":"result.txt"}',
});
const call = (seq: number, turn: number, name = "write_file") =>
  event(seq, "tool/call", {
    turn,
    step: 1,
    callId: "same-call",
    name,
    arguments: '{"path":"result.txt"}',
  });
const result = (seq: number, turn: number, output: string, failed = false) =>
  event(seq, "tool/result", {
    turn,
    step: 1,
    message: {
      id: `result-${seq}`,
      role: "tool",
      toolCallId: "same-call",
      isError: failed,
      content: [{ type: "text", text: output }],
    },
    ...(failed
      ? { error: { code: "FAILED", name: "Error", reason: output } }
      : {}),
  });
const attempt = (
  stream: SessionAssistantStreamAttempt["stream"],
): SessionAssistantStreamAttempt => ({
  attemptId: "fixture-attempt" as SessionAssistantStreamAttempt["attemptId"],
  turn: 1,
  step: 1,
  startedAfterSeq: 0 as SessionAssistantStreamAttempt["startedAfterSeq"],
  nextIndex: 1,
  stream,
});

describe("default native transcript", () => {
  it("renders append-origin conversation, keeps step identity and hides model-only replacements and prompts", async () => {
    const raw = [
      event(0, "system/message", {
        turn: 1,
        step: 1,
        message: { content: [{ type: "text", text: "private system prompt" }] },
      }),
      user(1, "Visible question"),
      assistant(2, 1, [
        { type: "reasoning", text: "Native reasoning" },
        { type: "text", text: "Native answer" },
      ]),
      event(
        3,
        "user/message",
        {
          id: "compact",
          source: { kind: "compaction" },
          content: [{ type: "text", text: "model-only replacement" }],
        },
        { op: "replace", startSeq: 1, endSeq: 2 },
      ),
    ];
    const original = JSON.stringify(raw);
    const view = render(
      <AgentNativeTranscript
        events={raw}
        projectPath="/project"
        sessionId="lc:one"
      />,
    );
    expect(screen.getByText("Visible question")).toBeVisible();
    expect(screen.getByText("Native answer")).toBeVisible();
    expect(screen.queryByText("private system prompt")).toBeNull();
    expect(screen.queryByText("model-only replacement")).toBeNull();
    expect(
      view.container.querySelector('[data-native-event-seq="2"]'),
    ).toHaveAttribute("data-native-turn", "1");
    expect(
      view.container.querySelector('[data-native-event-seq="2"]'),
    ).toHaveAttribute("data-native-step", "1");
    expect(screen.queryByText("Native reasoning")).toBeNull();
    await userEvent.click(screen.getByText("思考过程"));
    expect(screen.getByText("Native reasoning")).toBeVisible();
    expect(JSON.stringify(raw)).toBe(original);
  });

  it("updates the declared tool in place and correlates reused call ids by turn and step", async () => {
    const view = render(
      <AgentNativeTranscript
        projectPath="/project"
        events={[
          assistant(0, 1, [tool()]),
          call(1, 1),
          result(2, 1, "first result"),
          assistant(3, 2, [tool()]),
          call(4, 2),
          result(5, 2, "second failure", true),
        ]}
      />,
    );
    const cards =
      view.container.querySelectorAll<HTMLDetailsElement>(".wb-tool");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute("data-state", "completed");
    expect(cards[1]).toHaveAttribute("data-state", "error");
    await userEvent.click(cards[0].querySelector("summary")!);
    expect(within(cards[0]).getByText("first result")).toBeVisible();
    expect(within(cards[0]).queryByText("second failure")).toBeNull();
    await userEvent.click(cards[1].querySelector("summary")!);
    expect(within(cards[1]).getByRole("alert")).toHaveTextContent(
      "second failure",
    );
  });

  it("shows a paged-in tool result without fabricating an earlier assistant message", async () => {
    const view = render(
      <AgentNativeTranscript
        projectPath="/project"
        events={[result(10, 3, "result in this page")]}
      />,
    );
    expect(screen.getAllByRole("article")).toHaveLength(1);
    const card = view.container.querySelector<HTMLDetailsElement>(".wb-tool")!;
    expect(card).toHaveAttribute("data-state", "completed");
    await userEvent.click(card.querySelector("summary")!);
    expect(screen.getByText("result in this page")).toBeVisible();
  });

  it("assembles live compact chunks using the official block assembler and accepts its final block", () => {
    const view = render(
      <AgentNativeTranscript
        projectPath="/project"
        events={[user(0)]}
        activeAttempt={attempt([
          {
            type: "text-chunks",
            time0: 1,
            index: 0,
            dt: [1],
            texts: ["Raw ", "deltas"],
          },
          {
            type: "chunk",
            time: 3,
            chunk: {
              type: "block-end",
              index: 0,
              block: { type: "text", text: "Final official block" },
            },
          },
        ])}
      />,
    );
    expect(screen.getByText("Final official block")).toBeVisible();
    expect(screen.queryByText("Raw deltas")).toBeNull();
    view.rerender(
      <AgentNativeTranscript
        projectPath="/project"
        events={[
          user(0),
          assistant(1, 1, [{ type: "text", text: "Final official block" }]),
        ]}
      />,
    );
    expect(screen.getAllByText("Final official block")).toHaveLength(1);
    expect(
      screen.queryByRole("article", { name: "Agent 正在回复" }),
    ).toBeNull();
  });

  it("retains failed attempts and explicit termination reasons without dispatching an attempted tool", async () => {
    const view = render(
      <AgentNativeTranscript
        projectPath="/project"
        events={[
          event(0, "assistant/attempt", {
            turn: 1,
            step: 1,
            stream: [
              {
                type: "text-chunks",
                time0: 1,
                index: 0,
                dt: [],
                texts: ["Attempted output"],
              },
              {
                type: "chunk",
                time: 2,
                chunk: {
                  type: "block-end",
                  index: 1,
                  block: tool("not-dispatched"),
                },
              },
            ],
          }),
          assistant(1, 1, [{ type: "text", text: "Successful retry" }]),
          event(2, "turn/end", { turn: 1, reason: { kind: "max-tokens" } }),
        ]}
      />,
    );
    expect(screen.getByText("Successful retry")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "本轮达到模型输出上限",
    );
    expect(view.container.querySelectorAll(".wb-tool")).toHaveLength(0);
    await userEvent.click(screen.getByText("此模型尝试未形成回复"));
    expect(screen.getByText("Attempted output")).toBeVisible();
    expect(view.container.querySelectorAll(".wb-tool")).toHaveLength(0);
  });

  it("stops an undispatched tool when its own turn was cancelled, preserving later turns", () => {
    const view = render(
      <AgentNativeTranscript
        projectPath="/project"
        events={[
          assistant(0, 1, [tool()]),
          event(2, "turn/end", { turn: 1, reason: { kind: "aborted" } }),
          assistant(3, 2, [tool()]),
          call(4, 2),
        ]}
      />,
    );
    const cards = view.container.querySelectorAll(".wb-tool");
    expect(cards[0]).toHaveAttribute("data-state", "error");
    expect(cards[1]).toHaveAttribute("data-state", "running");
  });

  it("resolves upload images by explicit message aliases and keeps unresolved references visible", () => {
    const prompt = event(0, "user/message", {
      id: "official-message-id",
      role: "user",
      source: { kind: "user", rpcId: "request-id" },
      content: [
        {
          type: "image",
          attachment: { attachmentId: "opaque-image-id", name: "cached.png" },
        },
        {
          type: "image",
          attachment: {
            attachmentId: "another-image-id",
            name: "unresolved.png",
          },
        },
      ],
    });
    render(
      <AgentNativeTranscript
        projectPath="/project"
        events={[prompt]}
        imageAttachmentsByMessage={{
          "ui-request-id": [
            {
              id: "image",
              fileName: "cached.png",
              dataUrl: "data:image/png;base64,AA==",
              mime: "image/png",
              bytes: 1,
            },
          ],
        }}
        messageAliases={{ "official-message-id": "ui-request-id" }}
      />,
    );
    expect(screen.getByRole("img", { name: "cached.png" })).toBeVisible();
    expect(screen.getByText("unresolved.png")).toBeVisible();
    expect(screen.queryByText("opaque-image-id")).toBeNull();
  });

  it("expands the local window before requesting older official history and retains mounted rows", () => {
    const scroll = vi.fn();
    const older = vi.fn();
    const view = render(
      <AgentNativeTranscript
        projectPath="/project"
        sessionId="lc:first"
        events={Array.from({ length: 100 }, (_, index) => user(index))}
        hasMore
        onLoadEarlier={scroll}
        onLoadOlder={older}
      />,
    );
    expect(screen.getAllByRole("article")).toHaveLength(40);
    const last = screen.getByText("Question 99").closest("article");
    fireEvent.click(screen.getByRole("button", { name: "加载更早的消息" }));
    expect(screen.getAllByRole("article")).toHaveLength(80);
    expect(older).not.toHaveBeenCalled();
    expect(scroll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "加载更早的消息" }));
    expect(screen.getAllByRole("article")).toHaveLength(100);
    fireEvent.click(screen.getByRole("button", { name: "加载更早的消息" }));
    expect(older).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Question 99").closest("article")).toBe(last);
    view.rerender(
      <AgentNativeTranscript
        projectPath="/project"
        sessionId="lc:second"
        events={[user(200)]}
      />,
    );
    expect(screen.queryByText("Question 99")).toBeNull();
    expect(screen.getByText("Question 200")).toBeVisible();
  });

  it("does not treat initialization or model context as a visible conversation", () => {
    expect(
      hasNativeTranscriptContent([
        event(0, "system/message", {
          message: { content: [{ type: "text", text: "system" }] },
        }),
      ]),
    ).toBe(false);
    expect(hasNativeTranscriptContent([user(1)])).toBe(true);
    expect(hasNativeTranscriptContent([], attempt([]))).toBe(true);
  });

  it("reveals newly fetched older records while preserving the existing row identities", () => {
    const loadOlder = vi.fn();
    const view = render(
      <AgentNativeTranscript
        projectPath="/project"
        events={[user(5), user(6)]}
        hasMore
        onLoadOlder={loadOlder}
      />,
    );
    const recent = screen.getByText("Question 6").closest("article");
    fireEvent.click(screen.getByRole("button", { name: "加载更早的消息" }));
    expect(loadOlder).toHaveBeenCalledTimes(1);
    view.rerender(
      <AgentNativeTranscript
        projectPath="/project"
        events={[user(5), user(6)]}
        hasMore
        loadingEarlier
        onLoadOlder={loadOlder}
      />,
    );
    view.rerender(
      <AgentNativeTranscript
        projectPath="/project"
        events={[user(1), user(2), user(5), user(6)]}
        onLoadOlder={loadOlder}
      />,
    );
    expect(screen.getByText("Question 1")).toBeVisible();
    expect(screen.getByText("Question 6").closest("article")).toBe(recent);
  });
});
