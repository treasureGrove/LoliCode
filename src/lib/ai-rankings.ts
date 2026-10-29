import snapshot from "./data/ai-rankings.json";

export const sourceIds = ["artificial-analysis", "livebench", "arena"] as const;
export type SourceId = (typeof sourceIds)[number];
export type RankingLicense = "all" | "open" | "proprietary";

export interface RankingSource {
  readonly id: SourceId;
  readonly name: string;
  readonly metric: string;
  readonly url: string;
  readonly dataUrl?: string;
  readonly updatedAt: string | null;
}

export interface RankingMeasurement {
  readonly score: number;
  readonly configuration: string;
  readonly url: string;
}

export interface RankingModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly icon: string;
  readonly openWeights: boolean;
  readonly measurements: Readonly<Record<SourceId, RankingMeasurement | null>>;
}

export interface RankingSnapshot {
  readonly retrievedAt: string;
  readonly sources: readonly RankingSource[];
  readonly models: readonly RankingModel[];
}

export const RANKINGS_FEED_URL =
  "https://lolicode.com/desktop-assets/ai-rankings.json";
export const MAX_RANKING_FEED_BYTES = 512 * 1024;

const sourceHosts: Readonly<Record<SourceId, readonly string[]>> = {
  "artificial-analysis": ["artificialanalysis.ai", "www.artificialanalysis.ai"],
  livebench: ["livebench.ai", "www.livebench.ai"],
  arena: ["arena.ai", "www.arena.ai"],
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid ranking feed object");
  return value as Record<string, unknown>;
}

function feedText(value: unknown, max: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("Invalid ranking feed text");
  return value;
}

function feedDate(value: unknown, latest: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < "2000-01-01" ||
    value > latest
  )
    throw new Error("Invalid ranking feed date");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new Error("Invalid ranking feed date");
  return value;
}

function sourceLink(value: unknown, source: SourceId): string {
  const raw = feedText(value, 2048);
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !sourceHosts[source].includes(url.hostname)
  )
    throw new Error("Invalid ranking feed source link");
  return url.href;
}

/** Remote data is reconstructed from a bounded, validated set of public fields. */
export function parseRankingSnapshot(
  value: unknown,
  now: Date = new Date(),
): RankingSnapshot {
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_RANKING_FEED_BYTES)
      throw new Error("Ranking feed exceeds size limit");
    value = JSON.parse(value);
  }
  const input = record(value);
  // A one-day allowance accommodates a server publishing in another timezone.
  const latest = new Date(now.getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const retrievedAt = feedDate(input.retrievedAt, latest);
  if (
    !Array.isArray(input.sources) ||
    input.sources.length !== sourceIds.length
  )
    throw new Error("Ranking feed must identify all sources");
  const sourceRows = input.sources;
  const sources = sourceIds.map((id): RankingSource => {
    const matching = sourceRows.filter(
      (source: unknown) => record(source).id === id,
    );
    if (matching.length !== 1)
      throw new Error("Duplicate or missing ranking source");
    const source = record(matching[0]);
    return {
      id,
      name: feedText(source.name, 100),
      metric: feedText(source.metric, 100),
      url: sourceLink(source.url, id),
      ...(source.dataUrl === undefined
        ? {}
        : { dataUrl: sourceLink(source.dataUrl, id) }),
      updatedAt:
        source.updatedAt === null
          ? null
          : feedDate(source.updatedAt, retrievedAt),
    };
  });
  if (
    !Array.isArray(input.models) ||
    input.models.length < 2 ||
    input.models.length > 200
  )
    throw new Error("Invalid ranking model count");
  const ids = new Set<string>();
  const models = input.models.map((raw): RankingModel => {
    const model = record(raw);
    const id = feedText(model.id, 96);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || ids.has(id))
      throw new Error("Duplicate or invalid ranking model id");
    ids.add(id);
    const icon = feedText(model.icon, 64, true);
    if (!/^[a-z0-9-]*$/.test(icon) || typeof model.openWeights !== "boolean")
      throw new Error("Invalid ranking model metadata");
    const observations = record(model.measurements);
    if (
      Object.keys(observations).length !== sourceIds.length ||
      Object.keys(observations).some(
        (key) => !sourceIds.includes(key as SourceId),
      )
    )
      throw new Error("Invalid ranking measurement sources");
    const measurements = Object.fromEntries(
      sourceIds.map((source) => {
        const rawMeasurement = observations[source];
        if (rawMeasurement === null) return [source, null];
        const measurement = record(rawMeasurement);
        if (
          typeof measurement.score !== "number" ||
          !Number.isFinite(measurement.score) ||
          measurement.score < 0 ||
          measurement.score > (source === "arena" ? 5000 : 100)
        )
          throw new Error("Invalid ranking score");
        return [
          source,
          {
            score: measurement.score,
            configuration: feedText(measurement.configuration, 300),
            url: sourceLink(measurement.url, source),
          },
        ];
      }),
    ) as Record<SourceId, RankingMeasurement | null>;
    if (Object.values(measurements).filter(Boolean).length < 2)
      throw new Error("Ranking model needs two independent sources");
    return {
      id,
      name: feedText(model.name, 140),
      provider: feedText(model.provider, 100),
      icon,
      openWeights: model.openWeights,
      measurements,
    };
  });
  return deepFreeze({ retrievedAt, sources, models });
}

export interface RankedMeasurement extends RankingMeasurement {
  readonly percentile: number;
  /** One-based average rank: two models tied in positions 2 and 3 both get 2.5. */
  readonly cohortRank: number;
  readonly cohortSize: number;
}

export interface RankedModel extends Omit<RankingModel, "measurements"> {
  readonly rank: number;
  readonly composite: number;
  readonly coverage: number;
  readonly measurements: Readonly<Record<SourceId, RankedMeasurement | null>>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const rankingSnapshot = deepFreeze(snapshot as RankingSnapshot);

const isMeasured = (
  value: RankingMeasurement | null | undefined,
): value is RankingMeasurement => value != null && Number.isFinite(value.score);

/** Normalize within the eligible cohort; missing evidence never becomes a zero. */
export function rankModels(
  models: readonly RankingModel[],
): readonly RankedModel[] {
  const eligible = models.filter(
    (model) =>
      sourceIds.filter((source) => isMeasured(model.measurements[source]))
        .length >= 2,
  );
  const normalized = new Map<
    string,
    Partial<Record<SourceId, RankedMeasurement>>
  >();
  for (const source of sourceIds) {
    const cohort = eligible
      .filter((model) => isMeasured(model.measurements[source]))
      .slice()
      .sort(
        (a, b) => b.measurements[source]!.score - a.measurements[source]!.score,
      );
    for (let start = 0; start < cohort.length; ) {
      let end = start + 1;
      const score = cohort[start].measurements[source]!.score;
      while (
        end < cohort.length &&
        cohort[end].measurements[source]!.score === score
      )
        end++;
      const cohortRank = (start + 1 + end) / 2;
      // A single measured model is first in its cohort; avoid dividing by zero.
      const percentile =
        cohort.length > 1
          ? ((cohort.length - cohortRank) / (cohort.length - 1)) * 100
          : 100;
      for (let index = start; index < end; index++) {
        const model = cohort[index];
        const values = normalized.get(model.id) ?? {};
        values[source] = {
          ...model.measurements[source]!,
          percentile,
          cohortRank,
          cohortSize: cohort.length,
        };
        normalized.set(model.id, values);
      }
      start = end;
    }
  }
  const result = eligible.map((model) => {
    const measured = normalized.get(model.id)!;
    const values = Object.values(measured);
    const composite = Number(
      (
        values.reduce((sum, item) => sum + item.percentile, 0) / values.length
      ).toFixed(2),
    );
    return {
      ...model,
      composite,
      coverage: values.length,
      rank: 0,
      measurements: {
        "artificial-analysis": measured["artificial-analysis"] ?? null,
        livebench: measured.livebench ?? null,
        arena: measured.arena ?? null,
      },
    };
  });
  result.sort((a, b) => {
    const score = b.composite - a.composite;
    if (score) return score;
    const analysis =
      (b.measurements["artificial-analysis"]?.percentile ?? -1) -
      (a.measurements["artificial-analysis"]?.percentile ?? -1);
    if (analysis) return analysis;
    return a.name < b.name
      ? -1
      : a.name > b.name
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0;
  });
  for (let index = 0; index < result.length; index++) {
    result[index].rank =
      index > 0 && result[index].composite === result[index - 1].composite
        ? result[index - 1].rank
        : index + 1;
  }
  return deepFreeze(result);
}

export const rankedModels = rankModels(rankingSnapshot.models);

/** Filtering preserves the published global rank and cohort percentiles. */
export function filterRankedModels(
  models: readonly RankedModel[],
  search: string,
  provider: string,
  license: RankingLicense,
): readonly RankedModel[] {
  const query = search.trim().toLocaleLowerCase();
  return Object.freeze(
    models.filter(
      (model) =>
        (provider === "all" || model.provider === provider) &&
        (license === "all" ||
          (license === "open" ? model.openWeights : !model.openWeights)) &&
        (!query ||
          [
            model.id,
            model.name,
            model.provider,
            ...Object.values(model.measurements).map(
              (item) => item?.configuration ?? "",
            ),
          ].some((value) => value.toLocaleLowerCase().includes(query))),
    ),
  );
}
