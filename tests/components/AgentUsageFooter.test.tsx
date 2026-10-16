import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentUsageFooter } from "@/components/agent/AgentUsageFooter";

describe("AgentUsageFooter", () => {
  it("shows one compact session line with unknown missing counters", () => {
    render(<AgentUsageFooter />);
    const footer = screen.getByLabelText("本会话用量");
    expect(footer).toHaveTextContent("尚未记录用量");
    expect(footer).toHaveTextContent("缓存命中 未回报");
    expect(footer).not.toHaveTextContent(
      /本次任务|耗时|生成速度|用量回报|起计/,
    );
    expect(footer.querySelector("div")).toBeNull();
  });

  it("uses only session counters and keeps exact breakdown in the tooltip", () => {
    render(
      <AgentUsageFooter
        usage={{
          task: {
            inputTokens: 999,
            outputTokens: 123,
            modelRequests: 1,
            reportedRequests: 1,
            startedAt: 1,
            elapsedMs: 1000,
          },
          session: {
            inputTokens: 1000000,
            outputTokens: 200000,
            cacheReadTokens: 900000,
            cacheWriteTokens: 0,
            cacheHitRate: 0.9,
            modelRequests: 32,
            reportedRequests: 32,
            since: 1,
            complete: false,
          },
        }}
      />,
    );
    const footer = screen.getByLabelText("本会话用量");
    expect(footer).toHaveTextContent("会话用量 1.2M tokens");
    expect(footer).toHaveTextContent("缓存命中 90.0%");
    expect(footer).toHaveTextContent("32 轮");
    expect(footer).not.toHaveTextContent(/999|123|本次任务|用量回报|起计/);
    expect(footer.title).toContain("缓存读 900,000");
    expect(footer.title).toContain("较早历史未计入");
  });

  it("does not invent a total or accept an invalid cache hit rate", () => {
    render(
      <AgentUsageFooter
        usage={{
          session: {
            inputTokens: 1000,
            cacheHitRate: 1.5,
            modelRequests: 2,
            reportedRequests: 1,
            since: 1,
            complete: true,
          },
        }}
      />,
    );
    const footer = screen.getByLabelText("本会话用量");
    expect(footer).toHaveTextContent("用量待上游回报");
    expect(footer).toHaveTextContent("缓存命中 未回报");
  });

  it("preserves reported zero values", () => {
    render(
      <AgentUsageFooter
        usage={{
          session: {
            inputTokens: 0,
            outputTokens: 0,
            cacheHitRate: 0,
            modelRequests: 0,
            reportedRequests: 0,
            since: 1,
            complete: true,
          },
        }}
      />,
    );
    const footer = screen.getByLabelText("本会话用量");
    expect(footer).toHaveTextContent("会话用量 0 tokens");
    expect(footer).toHaveTextContent("缓存命中 0.0%");
    expect(footer).toHaveTextContent("0 轮");
  });

  it("retains paired historical totals while a new request is waiting for usage", () => {
    render(
      <AgentUsageFooter
        usage={{
          session: {
            inputTokens: 1000,
            outputTokens: 50,
            totalTokens: 1050,
            tokenReportedRequests: 2,
            modelRequests: 3,
            reportedRequests: 2,
            cacheHitRate: 0.8,
            since: 1,
            complete: true,
          },
        }}
      />,
    );
    const footer = screen.getByLabelText("本会话用量");
    expect(footer).toHaveTextContent("会话用量 1.1K tokens");
    expect(footer).toHaveTextContent("缓存命中 80.0%");
    expect(footer.title).toContain("1 次请求尚未完整回报");
  });

  it("does not combine input-only and output-only requests into a fabricated total", () => {
    render(
      <AgentUsageFooter
        usage={{
          session: {
            inputTokens: 1000,
            outputTokens: 50,
            tokenReportedRequests: 0,
            modelRequests: 2,
            reportedRequests: 2,
            since: 1,
            complete: true,
          },
        }}
      />,
    );
    const footer = screen.getByLabelText("本会话用量");
    expect(footer).toHaveTextContent("用量待上游回报");
    expect(footer).not.toHaveTextContent("1.1K");
  });
});
