import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { DetectResponse, type AccountView, type CategoryView, type JobView, type PayeeView, type RecurringList, type RecurringStatus, type RecurringView } from "@meridian/shared";
import { api, query } from "../lib/api.js";
import { money, shortDate } from "../lib/format.js";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";
import { ChargesPanel } from "../components/recurring/ChargesPanel.js";
import { RecurringForm } from "../components/recurring/RecurringForm.js";
import { SuggestionCard, type Panel } from "../components/recurring/SuggestionCard.js";
import { absCents, dueLabel, expectedLabel, localToday, scheduleSummary } from "../components/recurring/recurringFormat.js";
import { useRecurringMutations } from "../components/recurring/useRecurringMutations.js";
import "./RecurringPage.css";

type ListStatus = Exclude<RecurringStatus, "suggested">;
type Sort = "due" | "cost" | "name";
type Direction = "" | "inflow" | "outflow";

const TABS: Array<[ListStatus, string]> = [
  ["active", "Active"],
  ["paused", "Paused"],
  ["cancelled", "Cancelled"],
  ["dismissed", "Dismissed"],
];
const LIST_STATUSES: readonly string[] = TABS.map(([s]) => s);
const SCAN_TIMEOUT_MS = 5 * 60_000;
/** Keys that a finished detector run can change. */
const SCAN_KEYS = [["recurring"], ["alerts"], ["dashboard"], ["plan"], ["transactions"]] as const;

function isListStatus(s: string | null): s is ListStatus {
  return s !== null && LIST_STATUSES.includes(s);
}

export function RecurringPage() {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const focus = searchParams.get("focus");
  const today = useMemo(() => localToday(), []);
  const [tab, setTab] = useState<ListStatus>(() => {
    const s = searchParams.get("status");
    return isListStatus(s) ? s : "active";
  });
  const [direction, setDirection] = useState<Direction>("");
  const [sort, setSort] = useState<Sort>("due");
  const [open, setOpen] = useState<{ id: string; panel: Panel } | null>(null);
  const [adding, setAdding] = useState(false);
  const mutations = useRecurringMutations();

  const suggestions = useQuery({
    queryKey: ["recurring", "list", { status: "suggested", sort: "confidence" }],
    queryFn: () => api<RecurringList>(`/recurring${query({ status: "suggested", sort: "confidence" })}`),
  });
  const list = useQuery({
    queryKey: ["recurring", "list", { status: tab, direction, sort }],
    queryFn: () => api<RecurringList>(`/recurring${query({ status: tab, direction, sort })}`),
    placeholderData: keepPreviousData,
  });
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api<CategoryView[]>("/categories") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts") });
  const payees = useQuery({ queryKey: ["payees"], queryFn: () => api<PayeeView[]>("/payees"), enabled: adding });

  // Deep links (/recurring?focus=<id>, from alerts and the dashboard): find the item wherever it is, switch to its tab and scroll to it.
  const focusLookup = useQuery({
    queryKey: ["recurring", "list", { status: "all", sort: "due" }],
    queryFn: () => api<RecurringList>(`/recurring${query({ status: "all", sort: "due" })}`),
    enabled: focus !== null,
  });
  const focusedStatus = focus ? focusLookup.data?.items.find((i) => i.id === focus)?.status : undefined;
  useEffect(() => {
    if (focusedStatus && focusedStatus !== "suggested") {
      setTab(focusedStatus);
      setDirection("");
    }
  }, [focusedStatus]);
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || scrolledTo.current === focus) return;
    const el = document.getElementById(`rec-${focus}`);
    if (!el) return;
    scrolledTo.current = focus;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus, tab, list.data, suggestions.data]);

  // "Scan now": enqueue the detector and poll the job list until it finishes.
  const [scan, setScan] = useState<{ jobId: string; startedAt: number } | null>(null);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const detect = useMutation({
    mutationFn: () => api<typeof DetectResponse._output>("/recurring/detect", { method: "POST" }),
    onSuccess: (res) => {
      setScanNotice(res.created ? null : "A scan is already queued; waiting for it to finish.");
      setScan({ jobId: res.jobId, startedAt: Date.now() });
    },
  });
  const jobs = useQuery({
    queryKey: ["jobs", "detect", scan?.jobId],
    queryFn: () => api<JobView[]>("/jobs"),
    enabled: scan !== null,
    refetchInterval: 2000,
  });
  const job = scan ? jobs.data?.find((j) => j.id === scan.jobId) : undefined;
  const jobStatus = job?.status;
  const jobError = job?.lastError ?? null;
  const polledAt = jobs.dataUpdatedAt;
  useEffect(() => {
    if (!scan) return;
    const finished = jobStatus === "done" || jobStatus === "failed";
    if (!finished && Date.now() - scan.startedAt < SCAN_TIMEOUT_MS) return;
    setScan(null);
    if (jobStatus === "done") setScanNotice("Scan finished. New suggestions and alerts are listed below.");
    else if (jobStatus === "failed") setScanNotice(`Scan failed: ${jobError ?? "unknown error"}`);
    else setScanNotice("The scan is taking longer than expected. Reload later to see its results.");
    for (const queryKey of SCAN_KEYS) void qc.invalidateQueries({ queryKey });
  }, [scan, jobStatus, jobError, polledAt, qc]);

  const panelFor = (id: string): Panel | null => (open?.id === id ? open.panel : null);
  const togglePanel = (id: string, panel: Panel) => setOpen((o) => (o?.id === id && o.panel === panel ? null : { id, panel }));
  const setStatus = (item: RecurringView, status: "active" | "paused" | "cancelled") => {
    // Activating needs a category and an account; open the confirm form to collect them.
    if (status === "active" && (!item.categoryId || !item.accountId)) return togglePanel(item.id, "confirm");
    mutations.update.mutate({ id: item.id, status });
  };
  const remove = (item: RecurringView) => {
    const note = item.source === "detected" ? " Its charges are unlinked and the detector may suggest it again; use Dismiss to hide a series for good." : " Its charges are unlinked.";
    if (window.confirm(`Delete "${item.name}"?${note}`)) mutations.remove.mutate(item.id, { onSuccess: () => setOpen(null) });
  };

  const suggested = suggestions.data?.items ?? [];
  const items = list.data?.items ?? [];
  const totals = list.data?.totals;
  const cats = categories.data ?? [];
  const accts = accounts.data ?? [];

  return (
    <>
      <div className="row space wrap">
        <h1>Recurring</h1>
        <div className="row wrap">
          <button className="secondary" onClick={() => setAdding((v) => !v)} aria-pressed={adding}>
            {adding ? "Close form" : "Add recurring"}
          </button>
          <button onClick={() => detect.mutate()} disabled={detect.isPending || scan !== null} title="Run the detector over the last 36 months of charges">
            {scan ? "Scanning…" : "Scan now"}
          </button>
        </div>
      </div>
      <ErrorText error={detect.error} />
      <ErrorText error={mutations.remove.error} />
      {open === null && <ErrorText error={mutations.update.error} />}
      {scanNotice && (
        <p className="notice">
          {scanNotice}{" "}
          <button className="link" onClick={() => setScanNotice(null)}>
            dismiss
          </button>
        </p>
      )}

      {adding && (
        <Card title="Add a recurring item">
          <p className="muted small">For bills the detector cannot see yet (a yearly renewal, a new lease). The item starts active and links its charges as they post.</p>
          <RecurringForm
            mode="create"
            categories={cats}
            accounts={accts}
            payees={payees.data}
            pending={mutations.create.isPending}
            error={mutations.create.error}
            onCancel={() => setAdding(false)}
            onSubmit={(body) => mutations.create.mutate(body, { onSuccess: () => setAdding(false) })}
          />
        </Card>
      )}

      <Card title={`Suggested${suggested.length > 0 ? ` (${suggested.length})` : ""}`} actions={<span className="muted small">detected from your charges; confirm to plan them</span>}>
        <ErrorText error={suggestions.error} />
        {suggestions.isLoading && <p className="muted">Loading…</p>}
        {!suggestions.isLoading && suggested.length === 0 && <Empty>Nothing to review. New series show up here after a sync or a scan.</Empty>}
        {suggested.length > 0 && (
          <ul className="rec-suggestions">
            {suggested.map((item) => (
              <SuggestionCard
                key={item.id}
                item={item}
                today={today}
                panel={panelFor(item.id)}
                onPanel={(p) => setOpen(p ? { id: item.id, panel: p } : null)}
                categories={cats}
                accounts={accts}
                mutations={mutations}
                focused={focus === item.id}
              />
            ))}
          </ul>
        )}
      </Card>

      <div className="rec-toolbar">
        <div className="rec-tabs" role="tablist">
          {TABS.map(([s, label]) => (
            <button key={s} role="tab" aria-pressed={tab === s} aria-selected={tab === s} onClick={() => setTab(s)}>
              {label}
            </button>
          ))}
        </div>
        <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)} aria-label="Direction">
          <option value="">In and out</option>
          <option value="outflow">Money out</option>
          <option value="inflow">Money in</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="due">By next due</option>
          <option value="cost">By cost</option>
          <option value="name">By name</option>
        </select>
        {totals && items.length > 0 && (
          <span className="muted small rec-totals">
            {items.length} item{items.length === 1 ? "" : "s"} · {direction === "" ? "net " : ""}
            {money(absCents(totals.monthlyEquivalentCents))}/mo · {money(absCents(totals.yearlyCents))}/yr
          </span>
        )}
      </div>
      <ErrorText error={list.error} />
      {list.isLoading && <p className="muted">Loading…</p>}
      {!list.isLoading && items.length === 0 && (
        <Empty>
          {tab === "active" && "No active recurring items. Confirm a suggestion above or add one by hand."}
          {tab === "paused" && "Nothing is paused."}
          {tab === "cancelled" && "Nothing has been cancelled."}
          {tab === "dismissed" && "No dismissed suggestions."}
        </Empty>
      )}
      {items.length > 0 && (
        <div className="scroll">
          <table className="table rec-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="rec-col-schedule">Repeats</th>
                <th className="num">Amount</th>
                <th>Next due</th>
                <th className="rec-col-last">Last charge</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const panel = panelFor(item.id);
                const inflow = !item.expectedCents.startsWith("-");
                return [
                  <tr key={item.id} id={`rec-${item.id}`} className={focus === item.id ? "rec-focus" : ""}>
                    <td>
                      <strong>{item.name}</strong>
                      {item.source === "manual" && <Badge tone="neutral">manual</Badge>}
                      {item.transferAccountName && <Badge tone="info">transfer · {item.transferAccountName}</Badge>}
                      {item.statusReason === "missed_3" && <Badge tone="warn">auto-paused after 3 missed</Badge>}
                      <div className="muted small">
                        {item.payeeName !== item.name ? `${item.payeeName} · ` : ""}
                        {item.categoryName ?? "no category"}
                        {item.accountName ? ` · ${item.accountName}` : ""}
                      </div>
                    </td>
                    <td className="rec-col-schedule">{scheduleSummary(item)}</td>
                    <td className={`num nowrap ${inflow ? "pos" : ""}`}>
                      {inflow ? "+" : ""}
                      {expectedLabel(item)}
                      <div className="muted small">≈ {money(absCents(item.monthlyEquivalentCents))}/mo</div>
                    </td>
                    <td className="nowrap">
                      {item.status === "active" || item.status === "paused" ? dueLabel(item.nextDueDate, today) : "—"}
                      {item.overdue && (
                        <Badge tone="bad">
                          overdue · {item.consecutiveMissed} missed
                        </Badge>
                      )}
                      {item.nextDueDate && (item.status === "active" || item.status === "paused") && <div className="muted small">{shortDate(item.nextDueDate)}</div>}
                    </td>
                    <td className="rec-col-last nowrap">
                      {item.lastChargeDate ? (
                        <>
                          {shortDate(item.lastChargeDate)}
                          <div className="muted small">
                            {money(item.lastChargeCents)} · {item.chargeCount} charge{item.chargeCount === 1 ? "" : "s"}
                          </div>
                        </>
                      ) : (
                        <span className="muted">none yet</span>
                      )}
                    </td>
                    <td>
                      <div className="rec-actions">
                        {item.status === "active" && (
                          <button className="link" onClick={() => setStatus(item, "paused")} disabled={mutations.update.isPending}>
                            Pause
                          </button>
                        )}
                        {item.status === "paused" && (
                          <button className="link" onClick={() => setStatus(item, "active")} disabled={mutations.update.isPending}>
                            Resume
                          </button>
                        )}
                        {(item.status === "cancelled" || item.status === "dismissed") && (
                          <button className="link" onClick={() => setStatus(item, "active")} disabled={mutations.update.isPending}>
                            Reactivate
                          </button>
                        )}
                        {(item.status === "active" || item.status === "paused") && (
                          <button className="link" onClick={() => setStatus(item, "cancelled")} disabled={mutations.update.isPending}>
                            Cancel
                          </button>
                        )}
                        {item.status !== "dismissed" && (
                          <button className="link" onClick={() => togglePanel(item.id, "edit")} aria-pressed={panel === "edit"}>
                            Edit
                          </button>
                        )}
                        <button className="link" onClick={() => togglePanel(item.id, "charges")} aria-pressed={panel === "charges"}>
                          Charges
                        </button>
                        <button className="link danger" onClick={() => remove(item)} disabled={mutations.remove.isPending}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>,
                  panel && (
                    <tr key={`${item.id}-panel`} className="rec-expanded">
                      <td colSpan={6}>
                        {panel === "charges" && <ChargesPanel item={item} mutations={mutations} />}
                        {(panel === "edit" || panel === "confirm") && (
                          <RecurringForm
                            mode={panel}
                            item={item}
                            categories={cats}
                            accounts={accts}
                            pending={mutations.update.isPending}
                            error={mutations.update.error}
                            onCancel={() => setOpen(null)}
                            onSubmit={(body) => mutations.update.mutate({ id: item.id, ...body }, { onSuccess: () => setOpen(null) })}
                          />
                        )}
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      {tab === "dismissed" && (
        <p className="rec-note">Dismissed suggestions stay hidden while their charges keep arriving. A series that stops for longer than the three-year lookback and then restarts is suggested again.</p>
      )}
      {tab === "active" && items.length > 0 && (
        <p className="rec-note">Active bills and income are planned automatically in the matching months. An item that misses three charges in a row is paused so the plan stops expecting it.</p>
      )}
    </>
  );
}
