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

export const lolicodeAccountApi = {
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
