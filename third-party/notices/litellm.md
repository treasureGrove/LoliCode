# LiteLLM community implementation references

Upstream: https://github.com/BerriAI/litellm

Reviewed revision: `73aaf9e3daec8bb174accdf56ecade90b34c27c8` (2026-10-30).
The upstream license is preserved in [litellm-LICENSE](litellm-LICENSE). These references are
outside `enterprise/` and use the upstream MIT license, copyright Berri AI.

The Credit refactor adapts these community patterns to the existing LoliCode
gateway; it does not install the LiteLLM runtime or import enterprise code:

- `ui/litellm-dashboard/src/app/(dashboard)/hooks/users/useCurrentUser.ts`:
  one authenticated query for the current user's authoritative state.
- `ui/litellm-dashboard/src/app/(dashboard)/hooks/budgets/useBudgets.ts`:
  invalidate the shared budget query after successful changes.
- `ui/litellm-dashboard/src/app/(dashboard)/budgets/_components/EditBudgetModal.tsx`:
  keep an editable draft separate from the stored budget.
- `litellm/proxy/spend_tracking/spend_tracking_utils.py` and the public budget
  documentation: separate configured budget from recorded spend.

Local adaptations use a SQLite transaction for Credit reservations and
settlement, an exact integer microCredit ledger, an authenticated native API,
and a shared desktop quota query. LiteLLM's USD assumptions and two-decimal
budget rounding are not used for the ledger. See
`deploy/lolicode-relay/CREDIT_ARCHITECTURE.md` for the local contract.
