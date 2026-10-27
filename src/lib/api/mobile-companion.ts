import { invoke } from "@tauri-apps/api/core";

export interface MobileCompanionPair {
  roomId: string;
  relayUrl: string;
  approved: boolean;
  deviceId?: string | null;
  deviceName?: string | null;
  online: boolean;
  lastError?: string | null;
  sessionCount: number;
  expiresAt: number;
  accountId?: string | null;
  peerFingerprint?: string | null;
  transport?: "relay" | "direct" | "text" | null;
}

export interface CompanionAccountDevice {
  deviceId: string;
  deviceName: string;
  kind: "desktop" | "phone";
  publicKey: string;
  fingerprint: string;
  online: boolean;
  lastSeenAt: number;
}

export interface CompanionAccountRequest {
  requestId: string;
  accountId: string;
  challenge: string;
  desktop: CompanionAccountDevice;
  phone: CompanionAccountDevice;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "rejected";
  roomId?: string | null;
}

/** Public metadata only. Native code owns all tickets, keys and envelopes. */
export interface CompanionAccountStatus {
  protocol: 2;
  enabled: boolean;
  signedIn: boolean;
  accountId: string | null;
  device: CompanionAccountDevice | null;
  devices: CompanionAccountDevice[];
  requests: CompanionAccountRequest[];
  ticketExpiresAt: number | null;
  lastError: string | null;
  transportPolicy: "directOnly" | "directPreferredTextFallback";
  directAvailable: true;
}

export interface MobileCompanionStatus {
  hostName: string;
  protocol: 1;
  quietMode: boolean;
  pairs: MobileCompanionPair[];
  lastError?: string | null;
}

export const mobileCompanionApi = {
  accountStatus: () =>
    invoke<CompanionAccountStatus>("get_mobile_companion_account_status"),
  connectAccount: (deviceName?: string) =>
    invoke<CompanionAccountStatus>("connect_mobile_companion_account", {
      deviceName,
    }),
  setAccountVisible: (visible: boolean) =>
    invoke<CompanionAccountStatus>("set_mobile_companion_account_visible", {
      visible,
    }),
  approveAccountRequest: (requestId: string, phoneFingerprint: string) =>
    invoke<CompanionAccountStatus>("approve_mobile_companion_account_request", {
      requestId,
      phoneFingerprint,
    }),
  rejectAccountRequest: (requestId: string) =>
    invoke<CompanionAccountStatus>("reject_mobile_companion_account_request", {
      requestId,
    }),
  disconnectAccount: () =>
    invoke<CompanionAccountStatus>("disconnect_mobile_companion_account"),
  status: () => invoke<MobileCompanionStatus>("get_mobile_companion_status"),
  revoke: (roomId: string) =>
    invoke<void>("revoke_mobile_companion_device", { roomId }),
};
