import { useState } from "react";
import { money, shortDate } from "../../lib/format.js";
import { Badge, Empty } from "../ui.js";
import { EVENT_KIND_LABELS, isSkipped, type CashFlowEvent, type MoveScope, type WhatIf } from "./whatIfs.js";

interface Props {
  events: readonly CashFlowEvent[];
  whatIfs: readonly WhatIf[];
  onToggleSkip: (ev: CashFlowEvent) => void;
  onMove: (ev: CashFlowEvent, shiftDays: number, scope: MoveScope) => void;
  onRemoveOneTime: (ev: CashFlowEvent) => void;
}

const eventKey = (ev: CashFlowEvent): string => `${ev.date}|${ev.accountId}|${ev.kind}|${ev.recurringId ?? ""}|${ev.originalDate ?? ""}|${ev.amountCents}`;

/**
 * Upcoming projected events. Skipped rows are struck through, overdue rows
 * flagged, moved rows show where they came from. Row actions add what-ifs;
 * the page re-POSTs the projection on every change.
 */
export function EventsTable({ events, whatIfs, onToggleSkip, onMove, onRemoveOneTime }: Props) {
  const [moving, setMoving] = useState<{ key: string; shift: string; scope: MoveScope } | null>(null);
  if (events.length === 0) return <Empty>No recurring income, bills, transfers or card payments fall inside this horizon.</Empty>;
  const submitMove = (ev: CashFlowEvent) => {
    if (!moving) return;
    const shift = Number(moving.shift);
    if (!Number.isInteger(shift) || shift === 0) return;
    onMove(ev, shift, moving.scope);
    setMoving(null);
  };
  return (
    <table className="table small cf-events">
      <thead>
        <tr>
          <th>Date</th>
          <th>Account</th>
          <th>Event</th>
          <th className="num">Amount</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {events.map((ev, i) => {
          const key = `${eventKey(ev)}#${i}`;
          const skipped = !ev.applied || isSkipped(whatIfs, ev);
          const classes = [skipped ? "skipped" : "", ev.overdue ? "overdue" : ""].filter(Boolean).join(" ");
          const canWhatIf = ev.recurringId !== null && ev.originalDate !== null;
          const isMoving = moving?.key === key;
          return (
            <tr key={key} className={classes}>
              <td className="nowrap date">
                {shortDate(ev.date)}
                {ev.overdue && <Badge tone="bad">overdue</Badge>}
                {ev.moved && ev.originalDate && (
                  <div className="muted small">
                    moved from {shortDate(ev.originalDate)}
                    {ev.overdue ? ", posts today" : ""}
                  </div>
                )}
                {!ev.moved && ev.overdue && ev.originalDate && ev.originalDate !== ev.date && <div className="muted small">due {shortDate(ev.originalDate)}, posts today</div>}
              </td>
              <td className="muted nowrap">{ev.accountName}</td>
              <td>
                {ev.label}
                <div className="muted small">{EVENT_KIND_LABELS[ev.kind]}</div>
              </td>
              <td className={`num nowrap ${ev.amountCents.startsWith("-") ? "neg" : "pos"}`}>{money(ev.amountCents)}</td>
              <td className="actions">
                {canWhatIf && !isMoving && (
                  <>
                    <button className="link small" onClick={() => onToggleSkip(ev)}>
                      {skipped ? "Unskip" : "Skip"}
                    </button>
                    {!skipped && (
                      <button className="link small" onClick={() => setMoving({ key, shift: "", scope: "one" })}>
                        Move
                      </button>
                    )}
                  </>
                )}
                {canWhatIf && isMoving && moving && (
                  <form
                    className="cf-move"
                    onSubmit={(e) => {
                      e.preventDefault();
                      submitMove(ev);
                    }}
                  >
                    <input
                      type="number"
                      min={-366}
                      max={366}
                      step={1}
                      placeholder="±days"
                      value={moving.shift}
                      onChange={(e) => setMoving({ ...moving, shift: e.target.value })}
                      aria-label="Shift in days"
                      autoFocus
                    />
                    <select value={moving.scope} onChange={(e) => setMoving({ ...moving, scope: e.target.value as MoveScope })} aria-label="Which occurrences">
                      <option value="one">this one</option>
                      <option value="all">every occurrence</option>
                    </select>
                    <button type="submit" className="small" disabled={!Number.isInteger(Number(moving.shift)) || Number(moving.shift) === 0 || moving.shift === ""}>
                      Apply
                    </button>
                    <button type="button" className="link small" onClick={() => setMoving(null)}>
                      Cancel
                    </button>
                  </form>
                )}
                {ev.kind === "one_time" && (
                  <button className="link small danger" onClick={() => onRemoveOneTime(ev)}>
                    Remove
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
