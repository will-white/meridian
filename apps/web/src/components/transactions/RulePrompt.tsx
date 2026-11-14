import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { AlwaysRuleCheck, RuleView } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { alwaysRuleBody, alwaysRuleKey, blockedRuleText, ruleLabel, type RulePromptTarget } from "../../lib/recategorize.js";
import { Card, ErrorText } from "../ui.js";

interface Props {
  target: RulePromptTarget;
  categoryName: string | undefined;
  /** The rule was saved; `changed` other transactions were categorized by it. */
  onSaved: (changed: number) => void;
  onDismiss: () => void;
}

/**
 * The Phase 1 "always do this" prompt shown after a transaction is recategorized (in the register
 * or from the Plan page's drill-down): one click saves a payee rule and applies it to the
 * uncategorized rows. Before it offers that, it asks the API what the rules engine does for this
 * transaction (audit a8-ledger-ui-09, second round): a rule that already categorizes it so is
 * named instead, and so is an earlier rule that would keep a new one from deciding it.
 */
export function RulePrompt({ target, categoryName, onSaved, onDismiss }: Props) {
  const qc = useQueryClient();
  const check = useQuery({
    queryKey: alwaysRuleKey(target),
    queryFn: () => api<AlwaysRuleCheck>(`/transactions/${target.transactionId}/always-rule${query({ categoryId: target.categoryId })}`),
  });
  const createRule = useMutation({
    mutationFn: () => api<{ rule: RuleView; applied: { examined: number; changed: number } }>("/rules", { method: "POST", body: alwaysRuleBody(target, categoryName) }),
    onSuccess: (res) => {
      for (const key of [["transactions"], ["plan"], ["dashboard"], ["rules"]]) void qc.invalidateQueries({ queryKey: key });
      onSaved(res.applied.changed);
    },
  });
  const dismiss = (
    <button type="button" className="link" onClick={onDismiss}>
      dismiss
    </button>
  );
  const c = check.data;
  if (c?.verdict === "exists" && c.rule) {
    return (
      <p className="notice">
        {ruleLabel(c.rule)} already categorizes <strong>{target.payeeName}</strong> as <strong>{categoryName ?? "—"}</strong>. {dismiss}
      </p>
    );
  }
  const blocked = c ? blockedRuleText(c, target, categoryName) : null;
  if (blocked) {
    return (
      <p className="notice">
        {blocked} Change that rule on the <Link to="/rules">Rules page</Link>. {dismiss}
      </p>
    );
  }
  return (
    <Card>
      <div className="row wrap space">
        <span>
          Always categorize <strong>{target.payeeName}</strong> as <strong>{categoryName ?? "—"}</strong>?
          <span className="muted"> Creates a rule and applies it to uncategorized transactions.</span>
        </span>
        <span className="row">
          <button type="button" onClick={() => createRule.mutate()} disabled={createRule.isPending || check.isLoading}>
            Always do this
          </button>
          <button type="button" className="secondary" onClick={onDismiss}>
            Just this once
          </button>
        </span>
      </div>
      <ErrorText error={check.error} />
      <ErrorText error={createRule.error} />
    </Card>
  );
}
