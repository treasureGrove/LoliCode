import assert from "node:assert/strict";
import { test } from "node:test";
import { warmRequestPrompt } from "./harness-desktop-warm.mjs";

test("finds the current human marker before appended official context notices", () => {
  assert.equal(warmRequestPrompt([
    { role: "system", content: "Current working directory" },
    { role: "user", content: "HARNESS_DESKTOP_WARM_FIRST" },
    { role: "assistant", content: "Warm desktop first completed." },
    { role: "user", content: [{ type: "text", text: "HARNESS_DESKTOP_WARM_SECOND" }] },
    { role: "user", content: "Current working directory: C:/fixture/project." },
  ]), "HARNESS_DESKTOP_WARM_SECOND");
});

test("does not match a newer expected marker from a system message or an earlier turn", () => {
  const duplicate = warmRequestPrompt([
    { role: "user", content: "HARNESS_DESKTOP_WARM_FIRST" },
    { role: "system", content: "HARNESS_DESKTOP_WARM_SECOND" },
    { role: "user", content: "Directory and tool reminders" },
  ]);
  assert.equal(duplicate, "HARNESS_DESKTOP_WARM_FIRST");
  assert.notEqual(duplicate, "HARNESS_DESKTOP_WARM_SECOND");
  assert.equal(warmRequestPrompt([
    { role: "user", content: "HARNESS_DESKTOP_WARM_FIRST" },
    { role: "user", content: "HARNESS_DESKTOP_WARM_UNEXPECTED" },
  ]), "HARNESS_DESKTOP_WARM_UNEXPECTED");
  assert.equal(warmRequestPrompt([{ role: "user", content: "No fixture input" }]), undefined);
});
