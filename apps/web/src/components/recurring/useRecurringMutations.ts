import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RecurringView } from "@meridian/shared";
import { api } from "../../lib/api.js";
import type { CreateBody, UpdateBody } from "./recurringForm.js";

/** Keys that move when a recurring item changes: the plan's auto-filled bills, the dashboard's review counts, alerts resolved by confirm/dismiss, and charge links. */
const AFFECTED_KEYS = [["recurring"], ["plan"], ["dashboard"], ["alerts"], ["transactions"]] as const;

export function useRecurringMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    for (const queryKey of AFFECTED_KEYS) void qc.invalidateQueries({ queryKey });
  };
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & UpdateBody) => api<RecurringView>(`/recurring/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate,
  });
  const create = useMutation({
    mutationFn: (body: CreateBody) => api<RecurringView>("/recurring", { method: "POST", body }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/recurring/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  const link = useMutation({
    mutationFn: ({ id, transactionId }: { id: string; transactionId: string }) => api<RecurringView>(`/recurring/${id}/link`, { method: "POST", body: { transactionId } }),
    onSuccess: invalidate,
  });
  const unlink = useMutation({
    mutationFn: ({ id, transactionId }: { id: string; transactionId: string }) => api<RecurringView>(`/recurring/${id}/link/${transactionId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  return { update, create, remove, link, unlink };
}

export type RecurringMutations = ReturnType<typeof useRecurringMutations>;
