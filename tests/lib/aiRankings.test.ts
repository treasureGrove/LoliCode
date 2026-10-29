import { describe, expect, it } from "vitest";
import {
  filterRankedModels,
  rankedModels,
  rankingSnapshot,
  rankModels,
  sourceIds,
  type RankingModel,
  type SourceId,
} from "@/lib/ai-rankings";

function model(
  id: string,
  scores: Partial<Record<SourceId, number>>,
  options: Partial<
    Pick<RankingModel, "name" | "provider" | "openWeights">
  > = {},
): RankingModel {
  const measurement = (source: SourceId) =>
    scores[source] === undefined
      ? null
      : {
          score: scores[source]!,
          configuration: `${id} (Max)`,
          url: "https://example.com/benchmark",
        };
  return {
    id,
    name: id,
    provider: "Example",
    icon: "",
    openWeights: false,
    ...options,
    measurements: {
      "artificial-analysis": measurement("artificial-analysis"),
      livebench: measurement("livebench"),
      arena: measurement("arena"),
    },
  };
}

describe("AI ranking normalization", () => {
  it("uses average ranks for equal source scores and normalizes within the measured cohort", () => {
    const ranked = rankModels([
      model("a", { "artificial-analysis": 90, livebench: 80, arena: 70 }),
      model("b", { "artificial-analysis": 90, livebench: 60, arena: 90 }),
      model("c", { "artificial-analysis": 50, livebench: 60 }),
    ]);
    const a = ranked.find((item) => item.id === "a")!;
    const b = ranked.find((item) => item.id === "b")!;
    expect(a.measurements["artificial-analysis"]).toMatchObject({
      cohortRank: 1.5,
      cohortSize: 3,
      percentile: 75,
    });
    expect(b.measurements.livebench).toMatchObject({
      cohortRank: 2.5,
      cohortSize: 3,
      percentile: 25,
    });
    expect(b.measurements.arena).toMatchObject({
      cohortRank: 1,
      cohortSize: 2,
      percentile: 100,
    });
    expect(a.composite).toBe(58.33);
    expect(b.composite).toBe(66.67);
  });

  it("averages available evidence without replacing missing scores with zero", () => {
    const ranked = rankModels([
      model("a", { "artificial-analysis": 30, livebench: 30 }),
      model("b", { "artificial-analysis": 20, livebench: 20, arena: 100 }),
      model("c", { "artificial-analysis": 10, livebench: 10, arena: 0 }),
      model("one-source", { "artificial-analysis": 999 }),
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(ranked[0]).toMatchObject({ composite: 100, coverage: 2 });
    expect(ranked[0].measurements.arena).toBeNull();
    expect(ranked[0].measurements["artificial-analysis"]?.cohortSize).toBe(3);
    expect(ranked[2].measurements.arena?.score).toBe(0);
    expect(ranked[2].coverage).toBe(3);
  });

  it("assigns competition ranks to rounded composite ties and uses AA percentile to order them", () => {
    const ranked = rankModels([
      model("a", { "artificial-analysis": 10, livebench: 10 }),
      model("b", { "artificial-analysis": 20, livebench: 20, arena: 100 }),
      model("c", { "artificial-analysis": 30, livebench: 30, arena: 0 }),
    ]);
    expect(
      ranked.map(({ id, composite, rank }) => ({ id, composite, rank })),
    ).toEqual([
      { id: "c", composite: 66.67, rank: 1 },
      { id: "b", composite: 66.67, rank: 1 },
      { id: "a", composite: 0, rank: 3 },
    ]);
  });

  it("breaks remaining ties by name regardless of input order", () => {
    const rows = [
      model("z", { livebench: 10, arena: 10 }, { name: "Zulu" }),
      model("a", { livebench: 10, arena: 10 }, { name: "Alpha" }),
    ];
    expect(rankModels(rows).map((item) => item.name)).toEqual([
      "Alpha",
      "Zulu",
    ]);
    expect(rankModels([...rows].reverse())).toEqual(rankModels(rows));
    expect(rankModels(rows).map((item) => item.rank)).toEqual([1, 1]);
  });

  it("handles empty input, singleton cohorts and invalid numeric observations", () => {
    expect(rankModels([])).toEqual([]);
    const ranked = rankModels([
      model("a", { "artificial-analysis": NaN, livebench: 1, arena: 1 }),
    ]);
    expect(ranked[0]).toMatchObject({ composite: 100, coverage: 2 });
    expect(ranked[0].measurements["artificial-analysis"]).toBeNull();
    expect(ranked[0].measurements.livebench?.cohortSize).toBe(1);
  });

  it("does not mutate inputs and freezes returned rows and nested evidence", () => {
    const rows = [
      model("b", { livebench: 1, arena: 1 }),
      model("a", { livebench: 2, arena: 2 }),
    ];
    const original = structuredClone(rows);
    const ranked = rankModels(rows);
    expect(rows).toEqual(original);
    expect(Object.isFrozen(rows)).toBe(false);
    expect(Object.isFrozen(ranked)).toBe(true);
    expect(Object.isFrozen(ranked[0])).toBe(true);
    expect(Object.isFrozen(ranked[0].measurements)).toBe(true);
    expect(Object.isFrozen(ranked[0].measurements.livebench)).toBe(true);
    expect(ranked[0].measurements.livebench).not.toBe(
      rows[1].measurements.livebench,
    );
  });
});

describe("AI ranking filters", () => {
  const ranked = rankModels([
    model("a", { livebench: 3, arena: 3 }, { provider: "First" }),
    model(
      "b",
      { livebench: 2, arena: 2 },
      { name: "Second model", provider: "Second", openWeights: true },
    ),
    model("c", { livebench: 1, arena: 1 }, { provider: "First" }),
  ]);

  it("combines case-insensitive name/configuration search, provider and license", () => {
    expect(
      filterRankedModels(ranked, "  SECOND  ", "Second", "open").map(
        (item) => item.id,
      ),
    ).toEqual(["b"]);
    expect(
      filterRankedModels(ranked, "max", "First", "proprietary").map(
        (item) => item.id,
      ),
    ).toEqual(["a", "c"]);
    expect(filterRankedModels(ranked, "", "First", "open")).toEqual([]);
  });

  it("preserves global rank, cohort data and row identity after filtering", () => {
    const filtered = filterRankedModels(ranked, "", "Second", "all");
    expect(filtered[0]).toBe(ranked[1]);
    expect(filtered[0].rank).toBe(2);
    expect(filtered[0].measurements.livebench?.cohortSize).toBe(3);
    expect(Object.isFrozen(filtered)).toBe(true);
  });
});

describe("published AI ranking evidence", () => {
  it("includes a unique, immutable 20–30 model cohort supported by at least two official sources", () => {
    expect(rankingSnapshot.models.length).toBeGreaterThanOrEqual(20);
    expect(rankingSnapshot.models.length).toBeLessThanOrEqual(30);
    expect(new Set(rankingSnapshot.models.map((item) => item.id)).size).toBe(
      rankingSnapshot.models.length,
    );
    expect(rankedModels).toHaveLength(rankingSnapshot.models.length);
    expect(Object.isFrozen(rankingSnapshot.models)).toBe(true);
    for (const item of rankingSnapshot.models) {
      expect(
        sourceIds.filter((source) => item.measurements[source] !== null).length,
      ).toBeGreaterThanOrEqual(2);
      expect(Object.keys(item.measurements)).toEqual(sourceIds);
      for (const [source, value] of Object.entries(item.measurements)) {
        if (!value) continue;
        const url = new URL(value.url);
        expect(url.protocol).toBe("https:");
        expect(url.hostname).toBe(
          {
            "artificial-analysis": "artificialanalysis.ai",
            livebench: "livebench.ai",
            arena: "arena.ai",
          }[source],
        );
        expect(value.configuration.trim()).not.toBe("");
        expect(Number.isFinite(value.score)).toBe(true);
      }
    }
  });

  it("keeps source publication dates separate from retrieval and preserves official data links", () => {
    expect(rankingSnapshot.retrievedAt).toBe("2026-10-28");
    expect(
      rankingSnapshot.sources.find(
        (source) => source.id === "artificial-analysis",
      )?.updatedAt,
    ).toBeNull();
    expect(
      rankingSnapshot.sources.find((source) => source.id === "livebench"),
    ).toMatchObject({
      updatedAt: "2026-10-25",
      dataUrl: "https://livebench.ai/data/20261025/table.csv",
    });
    expect(
      rankingSnapshot.sources.find((source) => source.id === "arena")
        ?.updatedAt,
    ).toBe("2026-10-22");
    for (const source of rankingSnapshot.sources) {
      expect(new URL(source.url).protocol).toBe("https:");
      if (source.updatedAt)
        expect(source.updatedAt <= rankingSnapshot.retrievedAt).toBe(true);
    }
  });

  it("selects each source's best tested effort and does not merge distinct model releases", () => {
    const find = (id: string) =>
      rankingSnapshot.models.find((item) => item.id === id)!;
    expect(
      find("claude-fable-5.1").measurements["artificial-analysis"]
        ?.configuration,
    ).toBe("Claude Fable 5.1 (Xhigh, Default Fallback)");
    expect(
      find("grok-4.7").measurements["artificial-analysis"]?.configuration,
    ).toBe("Grok 4.7 (High)");
    expect(find("deepseek-v4.1-flash-1017").measurements.arena).toBeNull();
    expect(
      find("mistral-large-4").measurements["artificial-analysis"],
    ).toBeNull();
    expect(find("glm-5.3").measurements.livebench).toBeNull();
    expect(
      find("glm-5.3-flash").measurements["artificial-analysis"],
    ).toBeNull();
    expect(
      find("deepseek-v4-pro-0813").measurements.arena?.configuration,
    ).toContain("20260813");
    expect(find("gemini-3.8-flash").measurements.arena).toBeNull();
    expect(
      rankingSnapshot.models.some((item) => item.id.includes("wonder")),
    ).toBe(false);
  });
});
