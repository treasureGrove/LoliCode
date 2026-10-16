import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useLolicodeAccount,
  LOLICODE_ACCOUNT_QUERY_KEY,
} from "@/hooks/useLolicodeAccount";
import type { LolicodeAccountStatus } from "@/lib/api/lolicode-account";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

const signedOut: LolicodeAccountStatus = {
  account: null,
  persistent: true,
  warning: null,
};
const signedIn: LolicodeAccountStatus = {
  account: {
    id: "member-1",
    username: "alice",
    displayName: "Alice",
    avatarUrl: "https://lolicode.test/avatars/alice.png",
    profileUrl: "https://lolicode.test/u/alice",
  },
  persistent: true,
  warning: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

beforeEach(() => {
  native.invoke
    .mockReset()
    .mockImplementation((command: string) =>
      Promise.resolve(
        command === "lolicode_account_login" ? signedIn : signedOut,
      ),
    );
});

describe("useLolicodeAccount", () => {
  it("reads cached native status once without an implicit network refresh", async () => {
    const { wrapper } = harness();
    const { result } = renderHook(() => useLolicodeAccount(), { wrapper });
    await waitFor(() => expect(result.current.status).toEqual(signedOut));
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(native.invoke.mock.calls).toEqual([
      ["lolicode_account_status", { refresh: false }],
    ]);
    expect(result.current.account).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("refreshes explicitly and exposes the native persistence warning", async () => {
    const refreshed = {
      ...signedIn,
      persistent: false,
      warning: "系统凭据库不可用，仅在本次运行保存登录。",
    };
    const refreshRequest = deferred<LolicodeAccountStatus>();
    native.invoke.mockImplementation(
      (_command: string, args?: { refresh?: boolean }) =>
        args?.refresh ? refreshRequest.promise : Promise.resolve(signedOut),
    );
    const { wrapper } = harness();
    const { result } = renderHook(() => useLolicodeAccount(), { wrapper });
    await waitFor(() => expect(result.current.status).toEqual(signedOut));
    let refresh!: Promise<LolicodeAccountStatus>;
    act(() => {
      refresh = result.current.refresh();
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.isPending).toBe(true);
    await act(async () => {
      refreshRequest.resolve(refreshed);
      await refresh;
    });
    expect(result.current.account).toEqual(signedIn.account);
    expect(result.current.persistent).toBe(false);
    expect(result.current.warning).toBe(refreshed.warning);
    expect(result.current.isRefreshing).toBe(false);
  });

  it("updates the public cache after login without retaining the password in query or mutation data", async () => {
    const { client, wrapper } = harness();
    const { result } = renderHook(() => useLolicodeAccount(), { wrapper });
    await waitFor(() => expect(result.current.status).toEqual(signedOut));
    await act(async () => {
      await result.current.login("alice", "secret-entered-only-for-login");
    });
    expect(result.current.account).toEqual(signedIn.account);
    expect(client.getQueryData(LOLICODE_ACCOUNT_QUERY_KEY)).toEqual(signedIn);
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state),
      ),
    ).not.toContain("secret-entered-only-for-login");
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    await act(async () => {
      await result.current.logout();
    });
    expect(result.current.account).toBeNull();
    expect(client.getQueryData(LOLICODE_ACCOUNT_QUERY_KEY)).toEqual(signedOut);
  });

  it("does not restore an account when an old initial IPC read returns after logout", async () => {
    const initialRead = deferred<LolicodeAccountStatus>();
    native.invoke.mockImplementation((command: string) =>
      command === "lolicode_account_status"
        ? initialRead.promise
        : Promise.resolve(signedOut),
    );
    const { client, wrapper } = harness();
    const { result } = renderHook(() => useLolicodeAccount(), { wrapper });
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("lolicode_account_status", {
        refresh: false,
      }),
    );
    await act(async () => {
      await result.current.logout();
    });
    await act(async () => {
      initialRead.resolve(signedIn);
      await initialRead.promise;
    });
    expect(result.current.status).toEqual(signedOut);
    expect(client.getQueryData(LOLICODE_ACCOUNT_QUERY_KEY)).toEqual(signedOut);
    expect(result.current.error).toBeNull();
  });

  it("does not let a late refresh from another observer overwrite logout", async () => {
    const oldRefresh = deferred<LolicodeAccountStatus>();
    native.invoke.mockImplementation(
      (command: string, args?: { refresh?: boolean }) =>
        args?.refresh
          ? oldRefresh.promise
          : Promise.resolve(
              command === "lolicode_account_status" ? signedIn : signedOut,
            ),
    );
    const { client, wrapper } = harness();
    const first = renderHook(() => useLolicodeAccount(), { wrapper });
    const second = renderHook(() => useLolicodeAccount(), { wrapper });
    await waitFor(() =>
      expect(first.result.current.account).toEqual(signedIn.account),
    );
    let refresh!: Promise<LolicodeAccountStatus>;
    act(() => {
      refresh = first.result.current.refresh();
    });
    await waitFor(() => expect(first.result.current.isRefreshing).toBe(true));
    await act(async () => {
      await second.result.current.logout();
    });
    await act(async () => {
      oldRefresh.resolve(signedIn);
      await refresh;
    });
    expect(client.getQueryData(LOLICODE_ACCOUNT_QUERY_KEY)).toEqual(signedOut);
    expect(first.result.current.account).toBeNull();
    expect(second.result.current.account).toBeNull();
  });

  it("keeps the current public identity and reports operation errors without retrying login", async () => {
    native.invoke.mockImplementation((command: string) =>
      command === "lolicode_account_login"
        ? Promise.reject("登录失败，请检查用户名和密码。")
        : Promise.resolve(signedIn),
    );
    const { wrapper } = harness();
    const { result } = renderHook(() => useLolicodeAccount(), { wrapper });
    await waitFor(() =>
      expect(result.current.account).toEqual(signedIn.account),
    );
    await act(async () => {
      await expect(
        result.current.login("alice", "wrong-password"),
      ).rejects.toBe("登录失败，请检查用户名和密码。");
    });
    expect(result.current.error).toBe("登录失败，请检查用户名和密码。");
    expect(result.current.account).toEqual(signedIn.account);
    expect(result.current.isPending).toBe(false);
    expect(
      native.invoke.mock.calls.filter(
        ([command]) => command === "lolicode_account_login",
      ),
    ).toHaveLength(1);
  });

  it("can replace a failed initial status read with an explicit refresh", async () => {
    native.invoke
      .mockRejectedValueOnce(new Error("无法读取账户状态"))
      .mockResolvedValue(signedIn);
    const { wrapper } = harness();
    const { result } = renderHook(() => useLolicodeAccount(), { wrapper });
    await waitFor(() => expect(result.current.error).toBe("无法读取账户状态"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.account).toEqual(signedIn.account);
    expect(result.current.error).toBeNull();
  });
});
