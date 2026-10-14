import type { AccountView, CategoryView, RecurringView } from "@meridian/shared";
import { money, shortDate } from "../../lib/format.js";
import { Badge } from "../ui.js";
import { ChargesPanel } from "./ChargesPanel.js";
import { RecurringForm } from "./RecurringForm.js";
import { absCents, confidenceLabel, confidenceTone, dueLabel, expectedLabel, scheduleSummary } from "./recurringFormat.js";
import type { RecurringMutations } from "./useRecurringMutations.js";

export type Panel = "confirm" | "edit" | "charges";

interface Props {
  item: RecurringView;
  today: string;
  panel: Panel | null;
  onPanel: (panel: Panel | null) => void;
  categories: CategoryView[];
  accounts: AccountView[];
  mutations: RecurringMutations;
  focused: boolean;
}

/** One detected series awaiting review: confirm (with a category), edit, dismiss, or inspect its charges. */
export function SuggestionCard({ item, today, panel, onPanel, categories, accounts, mutations, focused }: Props) {
  const busy = mutations.update.isPending;
  const inflow = !item.expectedCents.startsWith("-");
  const toggle = (p: Panel) => onPanel(panel === p ? null : p);
  return (
    <li id={`rec-${item.id}`} className={`rec-suggestion${focused ? " rec-focus" : ""}`}>
      <div className="rec-suggestion-head">
        <div>
          <strong>{item.name}</strong>
          {item.payeeName !== item.name && <span className="muted"> · {item.payeeName}</span>}
          <Badge tone={confidenceTone(item.confidence)}>{confidenceLabel(item.confidence)}</Badge>
          <Badge tone={inflow ? "ok" : "neutral"}>{inflow ? "income" : "expense"}</Badge>
        </div>
        <div className="rec-actions">
          <button onClick={() => toggle("confirm")} disabled={busy} aria-pressed={panel === "confirm"}>
            Confirm…
          </button>
          <button className="secondary" onClick={() => toggle("edit")} disabled={busy} aria-pressed={panel === "edit"}>
            Edit
          </button>
          <button className="secondary" onClick={() => mutations.update.mutate({ id: item.id, status: "dismissed" })} disabled={busy} title="Hide this series. It stays hidden while its charges keep arriving.">
            Dismiss
          </button>
        </div>
      </div>
      <dl className="rec-facts">
        <div>
          <dt>Repeats</dt>
          <dd>{scheduleSummary(item)}</dd>
        </div>
        <div>
          <dt>Expected</dt>
          <dd>
            {expectedLabel(item)} <span className="muted small">≈ {money(absCents(item.monthlyEquivalentCents))}/mo</span>
          </dd>
        </div>
        <div>
          <dt>Next due</dt>
          <dd>
            {dueLabel(item.nextDueDate, today)}
            {item.nextDueDate && <span className="muted small"> ({shortDate(item.nextDueDate)})</span>}
          </dd>
        </div>
        <div>
          <dt>Based on</dt>
          <dd>
            <button className="link" onClick={() => toggle("charges")} aria-pressed={panel === "charges"}>
              {item.chargeCount} charge{item.chargeCount === 1 ? "" : "s"}
            </button>
            {item.firstChargeDate && (
              <span className="muted small">
                {shortDate(item.firstChargeDate)} – {shortDate(item.lastChargeDate)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Account</dt>
          <dd>{item.accountName ?? "—"}</dd>
        </div>
      </dl>
      {panel === "confirm" && (
        <RecurringForm
          mode="confirm"
          item={item}
          categories={categories}
          accounts={accounts}
          pending={busy}
          error={mutations.update.error}
          onCancel={() => onPanel(null)}
          onSubmit={(body) => mutations.update.mutate({ id: item.id, ...body }, { onSuccess: () => onPanel(null) })}
        />
      )}
      {panel === "edit" && (
        <RecurringForm
          mode="edit"
          item={item}
          categories={categories}
          accounts={accounts}
          pending={busy}
          error={mutations.update.error}
          onCancel={() => onPanel(null)}
          onSubmit={(body) => mutations.update.mutate({ id: item.id, ...body }, { onSuccess: () => onPanel(null) })}
        />
      )}
      {panel === "charges" && <ChargesPanel item={item} mutations={mutations} />}
    </li>
  );
}
