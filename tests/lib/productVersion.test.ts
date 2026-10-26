import { describe, it, expect } from "vitest";
import {
  productVersion,
  isLegacyVersion,
  PRODUCT_RELEASE,
} from "@/lib/productVersion";
import { compareVersions } from "@/lib/version";
import pkg from "../../package.json";
import tauri from "../../src-tauri/tauri.conf.json";

describe("independent product versioning", () => {
  it("shows v1.0.0 while native update comparisons continue above legacy", () => {
    expect(pkg.version).toBe(PRODUCT_RELEASE.buildVersion);
    expect(tauri.version).toBe(pkg.version);
    expect(productVersion(pkg.version)).toBe(PRODUCT_RELEASE.productVersion);
    expect(
      compareVersions(pkg.version, PRODUCT_RELEASE.legacyLastVersion),
    ).toBeGreaterThan(0);
  });
  it("maps patches, minors and prereleases without relabeling historical builds", () => {
    expect(productVersion("4.1.1")).toBe("1.0.1");
    expect(productVersion("4.2.0")).toBe("1.1.0");
    expect(productVersion("4.1.1-beta.2")).toBe("1.0.1-beta.2");
    expect(productVersion("4.0.22")).toBe("4.0.22");
    expect(isLegacyVersion("4.0.22")).toBe(true);
    expect(isLegacyVersion("4.1.0")).toBe(false);
    expect(productVersion("unknown")).toBe("unknown");
  });
});
