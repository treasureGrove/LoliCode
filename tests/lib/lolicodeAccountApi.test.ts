import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  lolicodeAccountApi,
  type LolicodeAccountStatus,
} from "@/lib/api/lolicode-account";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
const status: LolicodeAccountStatus = {
  account: null,
  persistent: true,
  warning: null,
};

beforeEach(() => native.invoke.mockReset().mockResolvedValue(status));

describe("LoliCode website account IPC", () => {
  it("keeps the initial status read local and refreshes only when requested", async () => {
    await expect(lolicodeAccountApi.status()).resolves.toBe(status);
    await lolicodeAccountApi.status(true);
    expect(native.invoke.mock.calls).toEqual([
      ["lolicode_account_status", { refresh: false }],
      ["lolicode_account_status", { refresh: true }],
    ]);
  });

  it("passes the entered password unchanged only to the native login command", async () => {
    await expect(
      lolicodeAccountApi.login("alice", " password with spaces "),
    ).resolves.toBe(status);
    expect(native.invoke).toHaveBeenCalledWith("lolicode_account_login", {
      identification: "alice",
      password: " password with spaces ",
    });
  });

  it("logs out without sending any credentials or provider account identifiers", async () => {
    await expect(lolicodeAccountApi.logout()).resolves.toBe(status);
    expect(native.invoke.mock.calls).toEqual([["lolicode_account_logout"]]);
  });
});
