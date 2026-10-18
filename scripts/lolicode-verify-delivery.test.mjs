import assert from "node:assert/strict";
import test from "node:test";
import {
  reviewedRedirect,
  validateStableFeed,
} from "./lolicode-verify-delivery.mjs";

function fixture() {
  const version = "4.0.21";
  const installer = `LoliCode-${version}-Windows-x64-Setup.exe`;
  const assets = {
    [installer]: { bytes: 100, sha256: "a".repeat(64) },
    "LoliCode-Portable.zip": { bytes: 80, sha256: "b".repeat(64) },
  };
  const local = { version, signature: "reviewed-signature", assets };
  const feed = {
    version,
    platforms: {
      "windows-x86_64": {
        signature: local.signature,
        url: `https://lolicode.com/downloads/releases/${version}/${installer}`,
      },
    },
    downloads: {
      "windows-x86_64-portable": {
        name: "LoliCode-Portable.zip",
        ...assets["LoliCode-Portable.zip"],
        url: `https://lolicode.com/downloads/releases/${version}/LoliCode-Portable.zip`,
      },
      "windows-x86_64-installer-github": {
        name: installer,
        ...assets[installer],
        url: `https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v${version}/${installer}`,
      },
    },
  };
  return { local, feed };
}

test("a public package with an old stable feed cannot pass delivery", () => {
  const { local, feed } = fixture();
  feed.version = "4.0.20";
  assert.throws(() => validateStableFeed(feed, local), /has not been promoted/);
});
test("stable delivery rejects RCs, signature changes and cross-version downloads", () => {
  for (const mutate of [
    ({ local }) => {
      local.version = "4.0.21-rc.2";
    },
    ({ feed }) => {
      feed.platforms["windows-x86_64"].signature = "wrong";
    },
    ({ feed }) => {
      feed.downloads["windows-x86_64-portable"].url =
        "https://lolicode.com/downloads/releases/4.0.20/LoliCode-Portable.zip";
    },
    ({ feed }) => {
      feed.downloads["windows-x86_64-installer-github"].sha256 = "c".repeat(64);
    },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateStableFeed(value.feed, value.local));
  }
  const value = fixture();
  validateStableFeed(value.feed, value.local);
});
test("only GitHub can take the reviewed signed storage hop", () => {
  const source =
    "https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v4.0.21/setup.exe";
  assert(
    reviewedRedirect(
      source,
      "https://release-assets.githubusercontent.com/test?signature=public-test",
    ),
  );
  for (const next of [
    "http://release-assets.githubusercontent.com/test",
    "https://user:pass@release-assets.githubusercontent.com/test",
    "https://release-assets.githubusercontent.com.evil/test",
    "https://example.com/test",
    "https://release-assets.githubusercontent.com:444/test",
  ]) {
    assert.equal(reviewedRedirect(source, next), false);
  }
  assert.equal(
    reviewedRedirect(
      "https://pub-example.r2.dev/file",
      "https://release-assets.githubusercontent.com/test",
    ),
    false,
  );
});
