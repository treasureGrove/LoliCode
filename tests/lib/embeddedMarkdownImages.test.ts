import { describe, expect, it } from "vitest";

import { prepareEmbeddedMarkdownImages as prepare } from "@/lib/embeddedMarkdownImages";

const src = "data:image/png;base64,aGVsbG8=";
const image = `![生成图](${src})`;

describe("prepareEmbeddedMarkdownImages", () => {
  it("shortens image targets while preserving surrounding Markdown", () => {
    const result = prepare(`**before**\n\n${image}\n\nafter`);
    expect(result.content).toBe(
      "**before**\n\n![生成图](https://lolicode.invalid/embedded-image/0)\n\nafter",
    );
    expect([...result.images.values()]).toEqual([src]);
  });

  it.each([
    `\`${image}\``,
    `\`\`\`md\n${image}\n\`\`\``,
    `    ${image}`,
    `>     ${image}`,
    `- ~~~md\n  ${image}\n  ~~~`,
    `> - ~~~md\n>   ${image}\n>   ~~~`,
    `\\${image}`,
  ])("preserves literal code and escaped image syntax: %s", (content) => {
    const result = prepare(content);
    expect(result.content).toBe(content);
    expect(result.images.size).toBe(0);
  });

  it.each(["\\` escaped tick", "an unmatched ` tick"])(
    "recognizes later paragraph images after %s",
    (prefix) => {
      const result = prepare(`${prefix}\n\n${image}`);
      expect(result.images.size).toBe(1);
      expect(result.content).not.toContain("data:image/");
      expect(result.content).toContain(prefix);
    },
  );

  it.each([
    `![生成图](${src} "title")`,
    `![生成图](<${src}> "title")`,
    `![生成图][output]\n\n[output]: ${src} "title"`,
    `![生成图][]\n\n[生成图]: ${src}`,
    `![生成图]\n\n[生成图]: ${src}`,
  ])("normalizes titled and reference images: %s", (content) => {
    const result = prepare(content);
    expect(result.images.size).toBe(1);
    expect(result.content.trim()).toBe(
      "![生成图](https://lolicode.invalid/embedded-image/0)",
    );
    expect(result.content).not.toContain("base64");
  });

  it("maps offsets past multiple large payloads without changing code samples", () => {
    const first = `data:image/png;base64,${"AAAA".repeat(20000)}`;
    const literal = `\`${image}\``;
    const result = prepare(`![first](${first})\n\n${literal}\n\n${image}`);
    expect(result.content).toContain(literal);
    expect(result.images.size).toBe(2);
    expect(result.content).toContain(
      "![生成图](https://lolicode.invalid/embedded-image/2)",
    );
  });

  it("keeps existing synthetic URLs separate from generated tokens", () => {
    const authored = "![remote](https://lolicode.invalid/embedded-image/0)";
    const result = prepare(`${authored}\n\n${image}`);
    expect(result.content).toContain(authored);
    expect(result.images.has("https://lolicode.invalid/embedded-image/0")).toBe(
      false,
    );
    expect(result.images.has("https://lolicode.invalid/embedded-image/1")).toBe(
      true,
    );
  });

  it("does not make ordinary data links active or change unused definitions", () => {
    const content = `[download](${src})\n\n[unused]: ${src}`;
    const result = prepare(content);
    expect(result.content).toBe(content);
    expect(result.images.size).toBe(0);
  });

  it("limits rendered image occurrences including repeated references", () => {
    const content = `${Array.from({ length: 18 }, () => "![图][output]").join("\n")}\n\n[output]: ${src}`;
    const result = prepare(content);
    expect(result.content.match(/!\[图\]/g)).toHaveLength(16);
    expect(result.content.match(/图片无法显示/g)).toHaveLength(2);
    expect(result.content).not.toContain("base64");
  });

  it("replaces oversized images with a small unavailable label", () => {
    const oversized = `data:image/png;base64,${"AAAA".repeat(1747627)}`;
    const result = prepare(`![过大](${oversized})`);
    expect(result.images.size).toBe(0);
    expect(result.content).toBe("图片无法显示：过大");
  });

  it("still recognizes valid images in prose larger than the rich-render limit", () => {
    const result = prepare(`${"x".repeat(70000)}\n\n${image}`);
    expect(result.images.size).toBe(1);
    expect(result.content).not.toContain("base64");
  });

  it("does not parse unbounded ordinary prose", () => {
    const content = `${"x".repeat(1024 * 1024)}\n\n${image}`;
    const result = prepare(content);
    expect(result.content).toBe(content);
    expect(result.images.size).toBe(0);
  });
});
