import release from "../../product-release.json";
import { compareVersions } from "./version";

export const PRODUCT_RELEASE = release;

/** The updater always compares the monotonic native build version. This mapping is display-only. */
export function productVersion(build: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(build);
  if (!match) return build;
  const [, major, minor, patch, pre = ""] = match;
  if (Number(major) < 4 || Number(minor) < 1) return build;
  return `${Number(major) - 3}.${Number(minor) - 1}.${patch}${pre}`;
}

export function isLegacyVersion(build: string): boolean {
  return (
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(build) &&
    compareVersions(build, release.legacyLastVersion) <= 0
  );
}
