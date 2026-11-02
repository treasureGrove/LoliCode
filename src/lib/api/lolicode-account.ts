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
  models: {
    id: string;
    name?: string;
    creditRate?: LolicodeCreditRate;
    creditPricing?: LolicodeCreditPricing;
  }[];
  limits?: { maxRequestBytes?: number; globalDailyCredits?: number | null };
  quota: {
    day: string;
    timezone: string;
    resetsAt: string;
    requestLimit: number | null;
    tokenLimit: number;
    requestsUsed: number;
    tokensUsed: number;
    tokensReserved: number;
    requestsRemaining: number | null;
    requestsUnlimited?: boolean;
    tokensRemaining: number;
    creditUnit?: "Credit";
    creditLimit?: number;
    creditsUsed?: number;
    creditsReserved?: number;
    creditsRemaining?: number;
    creditBalance?: LolicodeCreditBalance;
  };
}

export interface LolicodeCreditBalance {
  unit: "Credit";
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  pricingRevision: number;
  ledgerRevision: number;
}

export type LolicodeCreditPricing =
  | {
      unit: "Credit";
      mode: "tokens";
      perTokens: 1_000_000;
      prices: LolicodeCreditRate;
    }
  | { unit: "Credit"; mode: "request"; creditsPerRequest: number };

/** Credit charged per 1,000 tokens; cache tokens do not also count as normal input. */
export interface LolicodeCreditRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const lolicodeAccountApi = {
  /** One canonical summary also updates the public model catalog natively. */
  refreshRelay: () => invoke<LolicodeRelayStatus>("lolicode_relay_status"),
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
