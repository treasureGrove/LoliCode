import { invoke } from "@tauri-apps/api/core";

export type CopilotBillingKind = "ai_credits" | "premium_requests";

export interface CopilotBillingItem {
  product: string;
  sku: string;
  model: string;
  unitType: string;
  pricePerUnit: number;
  grossQuantity: number;
  grossAmount: number;
  discountQuantity: number;
  discountAmount: number;
  netQuantity: number;
  netAmount: number;
}

/** Official monthly totals cover all Copilot clients, with no IDE attribution. */
export interface CopilotBillingReport {
  accountLogin: string;
  year: number;
  month: number;
  kind: CopilotBillingKind;
  fetchedAt: number;
  source: "github-billing-api";
  items: CopilotBillingItem[];
}

export interface CopilotBillingSyncInput {
  accountId?: string;
  username: string;
  /** Used only for this sync; never stored with the report. */
  token?: string;
  year: number;
  month: number;
  kind: CopilotBillingKind;
}

export const COPILOT_BILLING_QUERY_KEY = [
  "copilot",
  "billing",
  "reports",
] as const;

export const copilotBillingApi = {
  listReports: (): Promise<CopilotBillingReport[]> =>
    invoke("copilot_billing_list_reports"),
  sync: (input: CopilotBillingSyncInput): Promise<CopilotBillingReport> =>
    invoke("copilot_billing_sync", { ...input }),
};
