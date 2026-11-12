import release from "../../product-release.json";
import { compareVersions } from "./version";

export const PRODUCT_RELEASE = release;

/** Historical 4.1 builds had separate public version numbers. */
export function productVersion(build: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(build);
  if (!match) return build;
  const [, major, minor, patch, pre = ""] = match;
  if (major !== "4" || minor !== "1") return build;
  return `1.0.${patch}${pre}`;
}

export const isPreviousBuildSeries = (build: string): boolean =>
  /^4\.[01]\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(build);

export function isLegacyVersion(build: string): boolean {
  return (
    isPreviousBuildSeries(build) &&
    compareVersions(build, release.legacyLastVersion) <= 0
  );
}
