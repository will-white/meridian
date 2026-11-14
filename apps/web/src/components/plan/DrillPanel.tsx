import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { Bucket, TransactionList, TransactionView } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { money, shortDate } from "../../lib/format.js";
import { drillDownQuery, type DrillTarget } from "../../lib/plan.js";
import { TRANSACTION_DRAG_TYPE, canDragToRecategorize } from "../../lib/recategorize.js";
import { amountInCategory } from "../../lib/splits.js";
import { Badge, Empty, ErrorText } from "../ui.js";

/** At most this many rows in the panel; the register link shows the rest. */
const PANEL_LIMIT = 100;

/** Under ['transactions'], so a recategorization (which invalidates that key) refreshes the panel. */
export function drillQueryKey(target: DrillTarget): readonly unknown[] {
  return ["transactions", "drill", drillDownQuery(target)];
}

export interface DrillCategory {
  id: string;
  name: string;
  bucket: Bucket;
}

interface Props {
  target: DrillTarget;
  /** "Groceries · Nov 2026" or "Uncategorized · Nov 2026". */
  title: string;
  /** The categories a row can move to (the grid's visible category rows). */
  categories: DrillCategory[];
  canEdit: boolean;
  onRecategorize: (t: TransactionView, categoryId: string) => void;
  onClose: () => void;
}

/**
 * The transactions behind a plan cell's actual (or a month's uncategorized ones), shown under the
 * grid on the Plan page. A row can be dragged onto any category row of the grid, or moved with its
 * select (the keyboard's way); either sends the register's PATCH and offers its rule prompt.
 */
export function DrillPanel({ target, title, categories, canEdit, onRecategorize, onClose }: Props) {
  const params = drillDownQuery(target);
  const list = useQuery({
    queryKey: drillQueryKey(target),
    queryFn: () => api<TransactionList>(`/transactions${query({ ...params, limit: PANEL_LIMIT })}`),
  });
  const items = list.data?.items ?? [];
  const categoryId = target.kind === "category" ? target.row.categoryId : null;
  const registerUrl = `/transactions${query(params)}`;

  return (
    <section className="plan-drill card" aria-label={`Transactions: ${title}`}>
      <div className="row space wrap plan-drill-head">
        <strong>{title}</strong>
        <span className="row">
          <Link to={registerUrl}>Open in the register</Link>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </span>
      </div>
      {canEdit && <p className="muted small">Drag a row onto a category in the grid above to move it there, or pick the category in its row.</p>}
      <ErrorText error={list.error} />
      {list.isLoading && <p className="muted">Loading…</p>}
      {!list.isLoading && items.length === 0 && <Empty>No transactions.</Empty>}
      {items.length > 0 && (
        <table className="table small plan-drill-table">
          <tbody>
            {items.map((t) => {
              const draggable = canEdit && canDragToRecategorize(t);
              const name = t.payeeName ?? t.rawDescription;
              return (
                <tr
                  key={t.id}
                  className={`${t.pending ? "pending" : ""} ${draggable ? "plan-drill-draggable" : ""}`}
                  draggable={draggable || undefined}
                  onDragStart={
                    draggable
                      ? (e) => {
                          e.dataTransfer.setData(TRANSACTION_DRAG_TYPE, t.id);
                          e.dataTransfer.effectAllowed = "move";
                        }
                      : undefined
                  }
                  title={draggable ? "Drag onto a category row to move it there" : undefined}
                >
                  <td className="nowrap">
                    {draggable && (
                      <span className="drag-handle" aria-hidden="true">
                        ⠿
                      </span>
                    )}
                    {shortDate(t.date)}
                  </td>
                  <td>
                    {name}
                    {t.pending && <Badge tone="info">pending</Badge>}
                    {t.isTransfer && <Badge tone="neutral">transfer</Badge>}
                    {t.splits.length > 0 && <Badge tone="neutral">split</Badge>}
                    <div className="muted">{t.accountName}</div>
                  </td>
                  <td>
                    {draggable ? (
                      <select aria-label={`Move ${name} to`} value={t.categoryId ?? ""} onChange={(e) => e.target.value && onRecategorize(t, e.target.value)}>
                        {t.categoryId === null && <option value="">— uncategorized —</option>}
                        {t.categoryId !== null && !categories.some((c) => c.id === t.categoryId) && <option value={t.categoryId}>{t.categoryName ?? "—"}</option>}
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">{t.isTransfer ? "transfer" : t.splits.length > 0 ? "split: edit in the register" : (t.categoryName ?? "uncategorized")}</span>
                    )}
                  </td>
                  <td className={`num nowrap ${t.amountCents.startsWith("-") ? "neg" : "pos"}`}>
                    {categoryId && t.splits.length > 0 ? money(amountInCategory(t, categoryId).toString()) : money(t.amountCents)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {list.data?.nextCursor && (
        <p className="muted small">
          The first {PANEL_LIMIT} are shown; <Link to={registerUrl}>the register</Link> has the rest.
        </p>
      )}
    </section>
  );
}
