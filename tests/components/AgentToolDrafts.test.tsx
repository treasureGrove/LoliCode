import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  AgentToolDraftsContext,
  useAgentToolDraft,
} from "@/features/agent/AgentToolDrafts";

const provider = (cache: Map<string, unknown>) =>
  function Provider({ children }: { children: ReactNode }) {
    return (
      <AgentToolDraftsContext.Provider value={cache}>
        {children}
      </AgentToolDraftsContext.Provider>
    );
  };

describe("useAgentToolDraft", () => {
  it("keeps a stable setter and does not replace a draft with fresh default objects", () => {
    const cache = new Map<string, unknown>();
    const view = renderHook(
      () => useAgentToolDraft("project-a", { text: "" }),
      {
        wrapper: provider(cache),
      },
    );
    const setter = view.result.current[1];
    act(() => setter({ text: "unsaved" }));
    for (let index = 0; index < 50; index++) view.rerender();
    expect(view.result.current[0]).toEqual({ text: "unsaved" });
    expect(view.result.current[1]).toBe(setter);
  });

  it("keeps late completion updates after the tool panel has unmounted", () => {
    const cache = new Map<string, unknown>();
    const wrapper = provider(cache);
    const view = renderHook(() => useAgentToolDraft("project-a", ""), {
      wrapper,
    });
    const setter = view.result.current[1];
    act(() => setter("draft that is being saved"));
    view.unmount();
    act(() => setter(""));
    const reopened = renderHook(() => useAgentToolDraft("project-a", ""), {
      wrapper,
    });
    expect(reopened.result.current[0]).toBe("");
  });

  it("applies an old project's late completion to its cache without replacing the active project", () => {
    const cache = new Map<string, unknown>();
    const view = renderHook(({ name }) => useAgentToolDraft(name, ""), {
      initialProps: { name: "project-a" },
      wrapper: provider(cache),
    });
    const oldSetter = view.result.current[1];
    act(() => oldSetter("saved draft"));
    view.rerender({ name: "project-b" });
    act(() => view.result.current[1]("new project's draft"));
    act(() => oldSetter(""));
    expect(view.result.current[0]).toBe("new project's draft");
    view.rerender({ name: "project-a" });
    expect(view.result.current[0]).toBe("");
  });

  it("preserves functional updates in the same event without a provider", () => {
    const view = renderHook(() => useAgentToolDraft("local", 0));
    act(() => {
      view.result.current[1]((value) => value + 1);
      view.result.current[1]((value) => value + 1);
    });
    expect(view.result.current[0]).toBe(2);
  });
});
