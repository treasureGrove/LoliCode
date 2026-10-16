import { useQueries } from "@tanstack/react-query";
import * as authApi from "@/lib/api/auth";
import type { ManagedAuthProvider } from "@/lib/api/auth";
import { useUsageSummary } from "@/lib/query/usage";
import { parseFiniteNumber } from "@/components/usage/format";
import type { UsageRangeSelection } from "@/types/usage";

const TODAY: UsageRangeSelection = { preset: "today" };
const MANAGED_AUTH_PROVIDERS: ManagedAuthProvider[] = [
  "github_copilot",
  "codex_oauth",
  "xai_oauth",
];

/**
 * Platform sidebar status: today's cost and shared account reauthentication.
 */
export function useSidebarStatus() {
  const { data: todaySummary } = useUsageSummary(TODAY, undefined, {
    refetchInterval: 60_000,
  });

  const authStatuses = useQueries({
    queries: MANAGED_AUTH_PROVIDERS.map((provider) => ({
      queryKey: ["managed-auth-status", provider],
      queryFn: () => authApi.authGetStatus(provider),
      staleTime: 60_000,
    })),
  });

  const todayCost = parseFiniteNumber(todaySummary?.totalCost) ?? 0;

  const authNeedsAttention = authStatuses.some((query) =>
    query.data?.accounts.some(
      (account) => account.requires_reauth || account.reauth_required === true,
    ),
  );

  return { todayCost, authNeedsAttention };
}
