import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RuleView } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { alwaysRuleBody, existingAlwaysRule, type RulePromptTarget } from "../../lib/recategorize.js";
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
 * uncategorized rows.
 */
export function RulePrompt({ target, categoryName, onSaved, onDismiss }: Props) {
  const qc = useQueryClient();
  // Audit a8-ledger-ui-09: when a rule already does this, say so instead of offering to write it again.
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => api<RuleView[]>("/rules") });
  const createRule = useMutation({
    mutationFn: () => api<{ rule: RuleView; applied: { examined: number; changed: number } }>("/rules", { method: "POST", body: alwaysRuleBody(target, categoryName) }),
    onSuccess: (res) => {
      for (const key of [["transactions"], ["plan"], ["dashboard"], ["rules"]]) void qc.invalidateQueries({ queryKey: key });
      onSaved(res.applied.changed);
    },
  });
  const existing = existingAlwaysRule(rules.data, target);
  if (existing) {
    return (
      <p className="notice">
        Rule #{existing.position}
        {existing.name ? ` "${existing.name}"` : ""} already categorizes <strong>{target.payeeName}</strong> as <strong>{categoryName ?? "—"}</strong>.{" "}
        <button type="button" className="link" onClick={onDismiss}>
          dismiss
        </button>
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
          <button type="button" onClick={() => createRule.mutate()} disabled={createRule.isPending || rules.isLoading}>
            Always do this
          </button>
          <button type="button" className="secondary" onClick={onDismiss}>
            Just this once
          </button>
        </span>
      </div>
      <ErrorText error={createRule.error} />
    </Card>
  );
}

