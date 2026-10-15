import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentUsageFooter } from "@/components/agent/AgentUsageFooter";

describe("AgentUsageFooter", () => {
  it("keeps missing usage unknown instead of estimating tokens from content", () => {
    const view = render(<AgentUsageFooter />);
    expect(view.container).toHaveTextContent("输入 —");
    expect(view.container).toHaveTextContent("缓存读 —");
    expect(view.container).toHaveTextContent("模型请求 — 轮");
    expect(view.container).toHaveTextContent("生成速度 —");
    expect(view.container).toHaveTextContent("缓存命中 —");
  });
  it("shows actual counters and generation speed without including tool or approval wait time", () => {
    const view = render(
      <AgentUsageFooter
        usage={{
          task: {
            inputTokens: 1234,
            outputTokens: 200,
            cacheReadTokens: 0,
            cacheHitRate: 0.25,
            modelRequests: 3,
            reportedRequests: 3,
            startedAt: 1,
            elapsedMs: 100000,
            generationMs: 4000,
          },
          session: {
            inputTokens: 3456,
            modelRequests: 4,
            reportedRequests: 2,
            since: 1000,
            complete: false,
          },
        }}
      />,
    );
    expect(view.container).toHaveTextContent("输入 1,234");
    expect(view.container).toHaveTextContent("缓存读 0");
    expect(view.container).toHaveTextContent("缓存写 —");
    expect(view.container).toHaveTextContent("耗时 100.0 秒");
    expect(view.container).toHaveTextContent("生成速度 50.0 tokens/秒");
    expect(view.container).toHaveTextContent("缓存命中 25.0%");
    expect(screen.getByText("已记录用量")).toBeVisible();
    expect(view.container).toHaveTextContent("用量回报 2/4");
  });
  it("does not claim complete generation speed when not every request reported usage", () => {
    const view = render(
      <AgentUsageFooter
        usage={{
          task: {
            outputTokens: 200,
            modelRequests: 3,
            reportedRequests: 2,
            startedAt: 1,
            elapsedMs: 5000,
            generationMs: 4000,
          },
        }}
      />,
    );
    expect(view.container).toHaveTextContent("生成速度 —");
  });
});
