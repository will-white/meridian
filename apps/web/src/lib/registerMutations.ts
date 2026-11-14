import type { InfiniteData, MutationOptions, QueryClient, QueryKey } from "@tanstack/react-query";
import type { TransactionList, TransactionView } from "@meridian/shared";
import { api } from "./api.js";
import { withCategory } from "./register.js";

export interface RecategorizeVars {
  transaction: TransactionView;
  categoryId: string | null;
}

interface Snapshot {
  snapshots: Array<[QueryKey, unknown]>;
}

const isRegisterPages = (data: unknown): data is InfiniteData<TransactionList, unknown> =>
  typeof data === "object" && data !== null && Array.isArray((data as { pages?: unknown }).pages);

/** What a change in the register refreshes: the lists, the plan and the dashboard. */
export function invalidateLedger(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ["transactions"] });
  void qc.invalidateQueries({ queryKey: ["plan"] });
  void qc.invalidateQueries({ queryKey: ["dashboard"] });
}

/**
 * The register's category change (audit a8-ledger-ui-16 and -05). The row shows the category
 * picked at once, in every loaded page, and goes back to what it was if the save fails; the
 * "always do this" prompt (`onSaved`) is offered only once the recategorization was saved,
 * never beside its error.
 */
export function recategorizeOptions(
  qc: QueryClient,
  categoryName: (id: string | null) => string | null,
  onSaved: (vars: RecategorizeVars, saved: TransactionView) => void,
): MutationOptions<TransactionView, Error, RecategorizeVars, Snapshot> {
  return {
    mutationFn: ({ transaction, categoryId }) => api<TransactionView>(`/transactions/${transaction.id}`, { method: "PATCH", body: { categoryId } }),
    onMutate: async ({ transaction, categoryId }) => {
      await qc.cancelQueries({ queryKey: ["transactions"] });
      const snapshots = qc.getQueriesData({ queryKey: ["transactions"] }).filter(([, data]) => isRegisterPages(data));
      for (const [key, data] of snapshots) qc.setQueryData(key, withCategory(data as InfiniteData<TransactionList, unknown>, transaction.id, categoryId, categoryName(categoryId)));
      return { snapshots };
    },
    onError: (_error, _vars, context) => {
      for (const [key, data] of context?.snapshots ?? []) qc.setQueryData(key, data);
    },
    onSuccess: (saved, vars) => onSaved(vars, saved),
    onSettled: () => invalidateLedger(qc),
  };
}
