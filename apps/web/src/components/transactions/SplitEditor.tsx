import { useState } from "react";
import type { CategoryView, TransactionView } from "@meridian/shared";
import { money } from "../../lib/format.js";
import { MAX_SPLIT_LINES, buildSplitLines, initialSplitDraft, splitRemainderLabel, type SplitDraftLine, type SplitRequestLine } from "../../lib/splits.js";
import { ErrorText } from "../ui.js";

export interface SplitEditorProps {
  transaction: TransactionView;
  categories: CategoryView[];
  pending: boolean;
  error: unknown;
  /** Two or more lines that add up to the amount; an empty list removes the split. */
  onSave: (lines: SplitRequestLine[]) => void;
  onCancel: () => void;
}

/**
 * Split one transaction across categories. Amounts are typed as parts of the transaction
 * ("60.00" of a $100.00 purchase); the footer shows what is still unassigned and Save sends
 * only lines that add up exactly. The rules live in lib/splits.ts.
 */
export function SplitEditor({ transaction, categories, pending, error, onSave, onCancel }: SplitEditorProps) {
  const total = BigInt(transaction.amountCents);
  const [lines, setLines] = useState<SplitDraftLine[]>(() => initialSplitDraft(transaction));
  const [problem, setProblem] = useState<string | null>(null);
  const status = splitRemainderLabel(total, lines);
  const patch = (index: number, change: Partial<SplitDraftLine>) => {
    setProblem(null);
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...change } : line)));
  };

  const save = () => {
    const built = buildSplitLines(total, lines);
    if (!built.ok) {
      setProblem(built.error);
      return;
    }
    onSave(built.lines);
  };

  return (
    <div className="split-editor">
      <p className="small muted">
        Split {money(transaction.amountCents)} across categories. Type each part as a positive amount; a minus sign marks a part that runs the other way (cash back).
      </p>
      {lines.map((line, i) => (
        <div className="split-line row wrap" key={i}>
          <select value={line.categoryId} onChange={(e) => patch(i, { categoryId: e.target.value })} aria-label={`Line ${i + 1} category`}>
            <option value="">— category —</option>
            {categories
              .filter((c) => !c.hidden || c.id === line.categoryId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <input value={line.amount} onChange={(e) => patch(i, { amount: e.target.value })} inputMode="decimal" placeholder="0.00" aria-label={`Line ${i + 1} amount`} className="split-amount" />
          <input value={line.memo} onChange={(e) => patch(i, { memo: e.target.value })} maxLength={200} placeholder="memo (optional)" aria-label={`Line ${i + 1} memo`} className="grow" />
          <button type="button" className="link small" onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))} disabled={lines.length <= 2} aria-label={`Remove line ${i + 1}`}>
            remove
          </button>
        </div>
      ))}
      <div className="row wrap space">
        <span className={status.done ? "muted small" : "small warn-text"}>{status.text}</span>
        <span className="row">
          <button type="button" className="link small" onClick={() => setLines((prev) => [...prev, { categoryId: "", amount: "", memo: "" }])} disabled={lines.length >= MAX_SPLIT_LINES}>
            add line
          </button>
          {transaction.splits.length > 0 && (
            <button type="button" className="secondary" onClick={() => onSave([])} disabled={pending} title="Back to one category for the whole transaction">
              Remove split
            </button>
          )}
          <button type="button" onClick={save} disabled={pending}>
            Save split
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </span>
      </div>
      {problem && <p className="error">{problem}</p>}
      <ErrorText error={error} />
    </div>
  );
}
