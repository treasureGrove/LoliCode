import { invoke } from "@tauri-apps/api/core";

export type DiscoveryKind = "rankings" | "free-ai";
export type DiscoveryCategory =
  | "general"
  | "coding"
  | "multimodal"
  | "platform";
export interface DiscoveryText {
  zh: string;
  en: string;
}
export interface DiscoveryEntry {
  id: string;
  kind: DiscoveryKind;
  name: string;
  category: DiscoveryCategory;
  url: string;
  sourceUrl: string;
  summary: DiscoveryText;
  offer: "ranking" | "free-tier" | "limited-free" | "trial";
  access: "public" | "account" | "varies";
  limits: DiscoveryText;
  checkedAt: string;
  expiresAt?: string;
  preview?: { filename: string; sha256: string; capturedAt: string };
}
export interface DiscoveryPreview {
  dataUrl: string;
  capturedAt: string;
  stale: boolean;
}
export interface DiscoverySnapshot {
  catalog: {
    schemaVersion: 1;
    revision: number;
    updatedAt: string;
    entries: DiscoveryEntry[];
  };
  source: "builtin" | "cache";
  favorites: string[];
}
export const discoveryKey = (app: DiscoveryKind) => ["discovery", app] as const;
export const discoveryApi = {
  preview: (id: string) =>
    invoke<DiscoveryPreview>("get_discovery_preview", { id }),
  get: (app: DiscoveryKind) =>
    invoke<DiscoverySnapshot>("get_discovery_catalog", { app }),
  refresh: (app: DiscoveryKind) =>
    invoke<DiscoverySnapshot>("refresh_discovery_catalog", { app }),
  favorite: (app: DiscoveryKind, id: string, saved: boolean) =>
    invoke<DiscoverySnapshot>("set_discovery_favorite", { app, id, saved }),
};

export function filterDiscovery(
  entries: DiscoveryEntry[],
  kind: DiscoveryKind,
  search: string,
  category: string,
  favoritesOnly: boolean,
  favorites: string[],
) {
  const query = search.trim().toLocaleLowerCase();
  return entries.filter(
    (entry) =>
      entry.kind === kind &&
      (category === "all" || entry.category === category) &&
      (!favoritesOnly || favorites.includes(entry.id)) &&
      (!query ||
        [
          entry.name,
          entry.summary.zh,
          entry.summary.en,
          entry.url,
          entry.limits.zh,
          entry.limits.en,
        ].some((value) => value.toLocaleLowerCase().includes(query))),
  );
}

export function discoveryLink(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname.includes(".") ||
    /(^|\.)localhost\.?$|\.local\.?$|^[\d.]+$/.test(url.hostname) ||
    url.hostname.includes(":")
  ) {
    throw new Error("Invalid public directory link");
  }
  return url.href;
}
