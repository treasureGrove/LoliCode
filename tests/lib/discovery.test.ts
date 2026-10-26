import { describe, it, expect } from "vitest";
import {
  discoveryLink,
  filterDiscovery,
  type DiscoveryEntry,
} from "@/lib/api/discovery";
import bundled from "@/public/discovery-v1.json";
const entries = bundled.entries as DiscoveryEntry[];
describe("public discovery entries", () => {
  it("accepts official HTTPS links and rejects executable, local or credential-bearing links", () => {
    for (const e of entries) {
      expect(discoveryLink(e.url)).toMatch(/^https:/);
      expect(discoveryLink(e.sourceUrl)).toMatch(/^https:/);
    }
    for (const link of [
      "javascript:alert(1)",
      "https://localhost/",
      "https://localhost./",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://user:pass@example.com/",
      "file:///C:/test",
    ]) {
      expect(() => discoveryLink(link)).toThrow();
    }
  });
  it("combines category, keyword and favorite filters", () => {
    expect(
      filterDiscovery(entries, "rankings", "编程", "coding", true, [
        "swe-bench",
      ]).map((x) => x.id),
    ).toEqual(["swe-bench"]);
    expect(
      filterDiscovery(entries, "free-ai", "  opencode  ", "all", false, []).map(
        (x) => x.id,
      ),
    ).toEqual(["opencode-zen"]);
  });
});
