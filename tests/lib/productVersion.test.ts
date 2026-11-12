import { describe, it, expect } from "vitest";
import {
  productVersion,
  isLegacyVersion,
  PRODUCT_RELEASE,
} from "@/lib/productVersion";
import pkg from "../../package.json";
import tauri from "../../src-tauri/tauri.conf.json";

describe("unified product versioning", () => {
  it("uses the same version across the app and build configuration", () => {
    expect(pkg.version).toBe(PRODUCT_RELEASE.buildVersion);
    expect(tauri.version).toBe(pkg.version);
    expect(pkg.version).toBe(PRODUCT_RELEASE.productVersion);
    expect(productVersion(pkg.version)).toBe(pkg.version);
    expect(isLegacyVersion(pkg.version)).toBe(false);
  });
  it("maps patches, minors and prereleases without relabeling historical builds", () => {
    expect(productVersion("4.1.1")).toBe("1.0.1");
    expect(productVersion("4.1.1-beta.2")).toBe("1.0.1-beta.2");
    expect(productVersion("4.0.22")).toBe("4.0.22");
    expect(isLegacyVersion("4.0.22")).toBe(true);
    expect(isLegacyVersion("4.1.0")).toBe(false);
    expect(productVersion("unknown")).toBe("unknown");
  });
});
