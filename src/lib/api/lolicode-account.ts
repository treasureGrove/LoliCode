import { invoke } from "@tauri-apps/api/core";

export interface LolicodeAccount {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string;
}

/** Public identity only. Session credentials remain in the native account service. */
export interface LolicodeAccountStatus {
  account: LolicodeAccount | null;
  persistent: boolean;
  warning: string | null;
}

export interface LolicodeRelayStatus {
  account: { id: string; username: string; displayName: string };
  ready: boolean;
  models: { id: string; name?: string }[];
  quota: {
    day: string;
    timezone: string;
    resetsAt: string;
    requestLimit: number;
    tokenLimit: number;
    requestsUsed: number;
    tokensUsed: number;
    tokensReserved: number;
    requestsRemaining: number;
    tokensRemaining: number;
  };
}

export const lolicodeAccountApi = {
  relayStatus: () => invoke<LolicodeRelayStatus>("lolicode_relay_status"),
  connectRelay: () => invoke<void>("lolicode_relay_connect"),
  status(refresh = false): Promise<LolicodeAccountStatus> {
    return invoke<LolicodeAccountStatus>("lolicode_account_status", {
      refresh,
    });
  },
  login(
    identification: string,
    password: string,
  ): Promise<LolicodeAccountStatus> {
    return invoke<LolicodeAccountStatus>("lolicode_account_login", {
      identification,
      password,
    });
  },
  logout(): Promise<LolicodeAccountStatus> {
    return invoke<LolicodeAccountStatus>("lolicode_account_logout");
  },
};
