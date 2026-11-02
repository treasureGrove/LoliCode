import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentApi } from "@/lib/api/agent";
import type { AgentPermissionMode } from "@/types/agent";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

beforeEach(() => native.invoke.mockReset().mockResolvedValue({ id: "lc:new" }));

describe("Agent session creation permissions", () => {
  it("sends full access to the engine when the caller omits a permission mode", async () => {
    await agentApi.createSession("opaque/model", "build");
    expect(native.invoke).toHaveBeenCalledWith("create_agent_session", {
      modelId: "opaque/model",
      mode: "build",
      title: undefined,
      permissionMode: "full_access",
      reasoningEffort: undefined,
    });
  });

  it.each<AgentPermissionMode>(["ask", "auto", "full_access"])(
    "preserves the caller's explicit %s mode",
    async (permissionMode) => {
      await agentApi.createSession(
        "opaque/model",
        "build",
        undefined,
        permissionMode,
      );
      expect(native.invoke).toHaveBeenCalledWith(
        "create_agent_session",
        expect.objectContaining({ permissionMode }),
      );
    },
  );
});
