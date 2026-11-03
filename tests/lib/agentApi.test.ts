import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentApi } from "@/lib/api/agent";
import type { AgentPermissionMode } from "@/types/agent";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

beforeEach(() => native.invoke.mockReset().mockResolvedValue({ id: "lc:new" }));

it("saves a reviewed policy revision and publishes only the previewed PR revisions", async () => {
  const preview = {
    headRevision: "a".repeat(40),
    baseRevision: "b".repeat(40),
    treeRevision: "c".repeat(40),
    title: "Review installation",
    body: "Verified in the worktree.",
  };
  await agentApi.setSecretaryGithubPolicy("lc:secretary", false, [], 7);
  await agentApi.getSecretaryDraftPr("lc:secretary", "task-1");
  await agentApi.publishSecretaryDraftPr("lc:secretary", "task-1", preview);
  expect(native.invoke.mock.calls).toEqual([
    [
      "set_agent_secretary_github_policy",
      {
        sessionId: "lc:secretary",
        enabled: false,
        rules: [],
        expectedRevision: 7,
      },
    ],
    [
      "get_agent_secretary_draft_pr",
      { sessionId: "lc:secretary", taskId: "task-1" },
    ],
    [
      "publish_agent_secretary_draft_pr",
      { sessionId: "lc:secretary", taskId: "task-1", ...preview },
    ],
  ]);
});

describe("queued message transport", () => {
  it("keeps image and document payloads identical to a direct send and targets queue actions by exact request ID", async () => {
    const images = [
      {
        id: "image",
        fileName: "preview.png",
        mime: "image/png",
        bytes: 4,
        dataUrl: "data:image/png;base64,dGVzdA==",
      },
    ];
    const documents = [
      {
        id: "document",
        fileName: "notes.md",
        mime: "text/markdown",
        bytes: 4,
        dataBase64: "dGVzdA==",
      },
    ];
    await agentApi.sendMessage(
      "lc:session",
      "next",
      "opaque/request",
      images,
      documents,
    );
    const payload = native.invoke.mock.calls[0][1];
    await agentApi.enqueueMessage(
      "lc:session",
      "next",
      "opaque/request",
      images,
      documents,
    );
    expect(native.invoke).toHaveBeenLastCalledWith(
      "enqueue_agent_message",
      payload,
    );
    expect(payload.attachments).toEqual([
      {
        ref: images[0].dataUrl,
        fileName: "preview.png",
        mime: "image/png",
        bytes: 4,
      },
      {
        dataBase64: "dGVzdA==",
        fileName: "notes.md",
        mime: "text/markdown",
        bytes: 4,
      },
    ]);
    await agentApi.removeQueuedMessage("lc:session", "opaque/request");
    expect(native.invoke).toHaveBeenLastCalledWith(
      "remove_queued_agent_message",
      { sessionId: "lc:session", requestId: "opaque/request" },
    );
    await agentApi.sendQueuedMessageNow("lc:session", "opaque/request");
    expect(native.invoke).toHaveBeenLastCalledWith(
      "send_queued_agent_message_now",
      { sessionId: "lc:session", requestId: "opaque/request" },
    );
  });
});

describe("local session synchronization", () => {
  it.each(["both", "import", "export"] as const)(
    "sends the %s direction without accepting a renderer-supplied filesystem path",
    async (direction) => {
      await agentApi.syncSessions(direction);
      expect(native.invoke).toHaveBeenCalledWith("sync_agent_sessions", {
        direction,
      });
    },
  );
});

describe("secretary task transport", () => {
  it("reads global companion activity without selecting a project or dispatching a task", async () => {
    const activity = [
      {
        sessionId: "lc:secretary",
        projectPath: "D:/project",
        title: "Secretary",
        status: "idle",
        tasks: [
          {
            id: "task-owned",
            sessionId: "lc:worker",
            title: "Needs approval",
            status: "waiting_permission",
            updatedAt: 42,
          },
        ],
      },
    ];
    native.invoke.mockResolvedValueOnce(activity);
    expect(await agentApi.getSecretaryActivity()).toEqual(activity);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith("get_agent_secretary_activity");
  });

  it("preserves unavailable activity as an error so the companion can show unknown state", async () => {
    native.invoke.mockRejectedValueOnce(
      new Error("Command get_agent_secretary_activity not found"),
    );
    await expect(agentApi.getSecretaryActivity()).rejects.toThrow("not found");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("opens the project secretary with the selected model, permissions and context", async () => {
    await agentApi.openSecretary(
      "opaque/model",
      "ask",
      "high",
      "D:/project with spaces",
      128_000,
    );
    expect(native.invoke).toHaveBeenCalledWith("open_agent_secretary", {
      modelId: "opaque/model",
      permissionMode: "ask",
      reasoningEffort: "high",
      projectPath: "D:/project with spaces",
      contextLimit: 128_000,
      locale: expect.any(String),
    });
  });

  it.each<AgentPermissionMode>(["ask", "auto", "full_access"])(
    "preserves explicit %s secretary permissions",
    async (permissionMode) => {
      await agentApi.openSecretary("opaque/model", permissionMode);
      expect(native.invoke).toHaveBeenCalledWith(
        "open_agent_secretary",
        expect.objectContaining({ permissionMode }),
      );
    },
  );

  it("keeps task ownership and request IDs in every task operation", async () => {
    await agentApi.getSecretary("lc:secretary");
    expect(native.invoke).toHaveBeenLastCalledWith("get_agent_secretary", {
      sessionId: "lc:secretary",
    });
    await agentApi.delegateSecretaryTask(
      "lc:secretary",
      "Inspect the regression",
      "Read the failing test and report the cause.",
      "opaque/delegate:1",
    );
    expect(native.invoke).toHaveBeenLastCalledWith(
      "delegate_agent_secretary_task",
      {
        sessionId: "lc:secretary",
        title: "Inspect the regression",
        instructions: "Read the failing test and report the cause.",
        requestId: "opaque/delegate:1",
        locale: expect.any(String),
      },
    );
    await agentApi.cancelSecretaryTask("lc:secretary", "opaque/task:1");
    expect(native.invoke).toHaveBeenLastCalledWith(
      "cancel_agent_secretary_task",
      { sessionId: "lc:secretary", taskId: "opaque/task:1" },
    );
  });

  it("sends follow-up attachments through the same payload as ordinary messages", async () => {
    const images = [
      {
        id: "image",
        fileName: "preview.png",
        mime: "image/png",
        bytes: 4,
        dataUrl: "data:image/png;base64,dGVzdA==",
      },
    ];
    const documents = [
      {
        id: "document",
        fileName: "notes.md",
        mime: "text/markdown",
        bytes: 4,
        localPath: "D:/documents/notes.md",
      },
    ];
    await agentApi.sendMessage(
      "lc:secretary",
      "Include this evidence",
      "opaque/follow-up:1",
      images,
      documents,
    );
    const payload = native.invoke.mock.calls[0][1];
    await agentApi.sendSecretaryTaskMessage(
      "lc:secretary",
      "opaque/task:1",
      "Include this evidence",
      "opaque/follow-up:1",
      images,
      documents,
    );
    expect(native.invoke).toHaveBeenLastCalledWith(
      "send_agent_secretary_task_message",
      { ...payload, taskId: "opaque/task:1" },
    );
    expect(payload.attachments[1]).toEqual({
      localPath: "D:/documents/notes.md",
      fileName: "notes.md",
      mime: "text/markdown",
      bytes: 4,
    });
  });
});

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
