import { beforeEach, expect, it, vi } from "vitest";
import { agentApi } from "@/lib/api/agent";

const transport = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as Array<{ onmessage: (message: unknown) => void }>,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: transport.invoke,
  Channel: class {
    onmessage = (_message: unknown) => {};
    constructor() {
      transport.channels.push(this);
    }
  },
}));

beforeEach(() => {
  transport.invoke.mockReset().mockResolvedValue(false);
  transport.channels.length = 0;
});

it("passes the private channel and acknowledges unchanged frames even when the consumer ignores them", async () => {
  const receive = vi.fn();
  await agentApi.watchSessionNative("lc:first", "subscription", receive, {
    maxMessages: 12,
  });
  expect(transport.invoke).toHaveBeenCalledWith("watch_agent_session_native", {
    sessionId: "lc:first",
    subscriptionId: "subscription",
    maxMessages: 12,
    onFrame: transport.channels[0],
  });
  const frame = {
    type: "event",
    event: { seq: 7, time: 1, type: "turn/start", data: { turn: 2 } },
  };
  const message = { subscriptionId: "subscription", deliveryId: 3, frame };
  transport.channels[0].onmessage(message);
  expect(receive).toHaveBeenCalledWith(message);
  expect(receive.mock.calls[0][0].frame).toBe(frame);
  expect(transport.invoke).toHaveBeenCalledWith("ack_agent_session_native", {
    subscriptionId: "subscription",
    deliveryId: 3,
  });
});

it("acknowledges in finally when a consumer rejects the frame", async () => {
  await agentApi.watchSessionNative("lc:first", "subscription", () => {
    throw new Error("consumer failed");
  });
  expect(() =>
    transport.channels[0].onmessage({
      subscriptionId: "subscription",
      deliveryId: 1,
      error: "ended",
    }),
  ).toThrow("consumer failed");
  expect(transport.invoke).toHaveBeenCalledWith("ack_agent_session_native", {
    subscriptionId: "subscription",
    deliveryId: 1,
  });
});

it("reports an acknowledgement failure to the same subscription", async () => {
  const receive = vi.fn();
  await agentApi.watchSessionNative("lc:first", "subscription", receive);
  transport.invoke.mockRejectedValueOnce(new Error("ack failed"));
  transport.channels[0].onmessage({
    subscriptionId: "subscription",
    deliveryId: 2,
    error: "ended",
  });
  await Promise.resolve();
  expect(receive).toHaveBeenLastCalledWith({
    subscriptionId: "subscription",
    error: "实时记录确认失败，请重新连接。",
  });
});
