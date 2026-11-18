import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App as ChatDemoApp } from "@/features/chat-demo/app/App";
import { Sider as ChatDemoSider } from "@/features/chat-demo/components/sider/Sider";
import { useChatStore } from "@/features/chat-demo/services/chat/store";
import { setApiKey, useSettings } from "@/features/chat-demo/services/settings";

describe("DeepSeek chat-demo integration", () => {
  beforeEach(() => {
    localStorage.clear();
    setApiKey(null);
    useChatStore.setState({
      ready: false,
      initError: false,
      importingHistory: false,
      sessions: [],
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
      streaming: {},
    });
  });

  it("renders the embedded welcome view with deep thinking and search toggles", async () => {
    render(
      <div>
        <ChatDemoSider embedded />
        <ChatDemoApp isActive embedded />
      </div>,
    );

    const root = document.getElementById("main-content");
    expect(root).toBeInTheDocument();
    expect(root).toHaveClass("ds-chat-demo-root");

    await waitFor(() => expect(useChatStore.getState().ready).toBe(true));

    const thinkingBtn = screen.getByRole("button", {
      name: /深度思考|DeepThink/i,
    });
    const searchBtn = screen.getByRole("button", {
      name: /联网搜索|智能搜索|Search/i,
    });
    expect(thinkingBtn).toHaveAttribute("aria-pressed", "false");
    expect(searchBtn).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(thinkingBtn);
    expect(useSettings.getState().thinking).toBe(true);
    expect(thinkingBtn).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(searchBtn);
    expect(useSettings.getState().search).toBe(true);
    expect(searchBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("opens settings dialog from the embedded sidebar and manages API key and data tabs", async () => {
    render(
      <div>
        <ChatDemoSider embedded />
        <ChatDemoApp isActive embedded />
      </div>,
    );

    await waitFor(() => expect(useChatStore.getState().ready).toBe(true));

    const settingsBtn = screen.getByRole("button", { name: /设置|Settings/i });
    fireEvent.click(settingsBtn);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();

    const dataTab = screen.getByRole("tab", { name: /数据管理|Data/i });
    fireEvent.click(dataTab);
    expect(dataTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByPlaceholderText(/API Key|sk-/i),
    ).toBeInTheDocument();
  });
});
