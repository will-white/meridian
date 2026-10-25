import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { isInvestmentAccountType } from "@meridian/shared";
import type { AccountView, ConnectionView, MappedTradeView, RowChoice, SecurityView, TradeKind, TradesCommitBody, TradesCsvMapping, TradesImportResult, TradesPreviewBody, TradesPreviewResponse } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { money, shortDate } from "../../lib/format.js";
import { formatQuantity, signedMoney } from "../../lib/investments.js";
import { tradeTypeLabel, tradeTypeTone } from "../../lib/investmentForms.js";
import {
  groupTradesByDate,
  handBuiltTradesMapping,
  ledgerMatchText,
  previewWarningText,
  rowOrderText,
  setActionKind,
  sortActions,
  TRADE_KINDS,
  tradeKindLabel,
  tradeRowMarker,
  tradesCommitLabel,
  tradesMappingIssues,
  tradesResultText,
  unknownActionsText,
} from "../../lib/importMapping.js";
import { localToday } from "../../lib/plan.js";
import { Badge, Card, Empty, ErrorText } from "../ui.js";
import { invalidateInvestments } from "../investments/queries.js";
import { previewQueryOptions } from "./previewQuery.js";
import { SecurityChoiceCell } from "./SecurityChoiceCell.js";
import { TradesMappingEditor } from "./TradesMappingEditor.js";

/**
 * Trade-history import (imports design §3.8–§3.9, §5): file, investment
 * account and saved trades profile → the mapping editor with the fee
 * columns, the fee and reinvest-rows switches and the row order → the preview:
 * the "actions found" table (each key mapped to a kind, unknown ones block the
 * commit), the rows grouped by date with duplicate / changed / edited markers,
 * derived values, warnings and ledger links → commit → the result line and a
 * link to review new securities.
 */
export function TradesImport({ accounts, connections }: { accounts: readonly AccountView[]; connections: readonly ConnectionView[] }) {
  const qc = useQueryClient();
  const today = useMemo(() => localToday(), []);
  const investmentAccounts = accounts.filter((a) => isInvestmentAccountType(a.type) && !a.closed);
  const profiles = connections.filter((c) => c.type === "csv" && c.csvKind === "trades" && c.tradesMapping);
  const securities = useQuery({ queryKey: ["securities", "all"], queryFn: () => api<SecurityView[]>("/investments/securities") });

  const [accountId, setAccountId] = useState("");
  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [profileId, setProfileId] = useState("");
  const [mapping, setMapping] = useState<TradesCsvMapping | null>(null);
  const [accountFilterValue, setAccountFilterValue] = useState("");
  const [choices, setChoices] = useState<ReadonlyMap<number, RowChoice>>(new Map());
  const [save, setSave] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [showAll, setShowAll] = useState(false);
  /** Bumped per chosen file: keys the preview and remounts the cards for a new file. */
  const [fileKey, setFileKey] = useState(0);

  const commit = useMutation({
    mutationFn: (body: TradesCommitBody) => api<TradesImportResult>("/import/trades/commit", { method: "POST", body }),
    onSuccess: () => {
      invalidateInvestments(qc);
      void qc.invalidateQueries({ queryKey: ["connections"] });
      void qc.invalidateQueries({ queryKey: ["investment-transactions"] });
      void qc.invalidateQueries({ queryKey: ["transactions"] });
      void qc.invalidateQueries({ queryKey: ["prices"] });
    },
  });

  const issues = mapping ? tradesMappingIssues(mapping) : [];
  const choiceList = useMemo(() => [...choices.values()], [choices]);
  const previewBody: TradesPreviewBody | null = useMemo(() => {
    if (!csvText || !accountId) return null;
    if (mapping && issues.length > 0) return null;
    const body: TradesPreviewBody = { csvText, accountId, choices: choiceList };
    if (mapping) body.mapping = mapping;
    else if (profileId) body.profileId = profileId;
    if (accountFilterValue) body.accountFilterValue = accountFilterValue;
    return body;
  }, [csvText, accountId, mapping, profileId, accountFilterValue, choiceList, issues.length]);

  // The preview re-runs whenever the file, account, profile, mapping, filter or choices change;
  // the last response stays on screen meanwhile (a mutation would unmount the cards per keystroke).
  const preview = useQuery(previewQueryOptions<TradesPreviewBody, TradesPreviewResponse>("/import/trades/preview", previewBody, fileKey));
  // Adopt the server's guessed or saved mapping when none is set locally; a placeholder (the previous body's response) never counts.
  const serverMapping = preview.isPlaceholderData ? null : (preview.data?.mapping ?? null);
  useEffect(() => {
    if (mapping === null && serverMapping !== null) setMapping(serverMapping);
  }, [mapping, serverMapping]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setMapping(null);
    setChoices(new Map());
    setFileKey((k) => k + 1);
    commit.reset();
    setCsvText(await file.text());
  };
  const patchChoice = (rowIndex: number, patch: Partial<Omit<RowChoice, "rowIndex">>) =>
    setChoices((prev) => {
      const next = new Map(prev);
      const current: RowChoice = next.get(rowIndex) ?? { rowIndex };
      const merged: RowChoice = { ...current };
      if ("security" in patch) {
        if (patch.security === undefined) delete merged.security;
        else merged.security = patch.security;
      }
      if ("split" in patch) {
        if (patch.split === undefined) delete merged.split;
        else merged.split = patch.split;
      }
      if (merged.security === undefined && merged.split === undefined) next.delete(rowIndex);
      else next.set(rowIndex, merged);
      return next;
    });

  const p = preview.data;
  const headers = p?.headers ?? [];
  const actions = p ? sortActions(p.actionsFound) : [];
  const unknownText = p ? unknownActionsText(p.unknownActions) : null;
  const reinvestHint = p?.trades.some((t) => t.warnings.includes("reinvest_without_dividend")) ?? false;
  const splitRowsNeedingRatio = p?.trades.filter((t) => t.type === "split" && (t.splitNum === null || t.splitDen === null)) ?? [];
  const visibleTrades = p ? (showAll ? p.trades : p.trades.slice(0, 100)) : [];
  const groups = groupTradesByDate(visibleTrades);
  const canCommit = Boolean(p && !preview.isPlaceholderData && mapping && accountId && issues.length === 0 && p.unknownActions === 0 && p.totalRows > 0 && !commit.isPending);

  const onCommit = () => {
    if (!p || !mapping || !previewBody) return;
    const body: TradesCommitBody = { ...previewBody, mapping, today };
    if (save && saveName.trim()) body.saveProfile = { ...(profileId ? { id: profileId } : {}), name: saveName.trim() };
    commit.mutate(body);
  };

  return (
    <>
      <Card title="1. File and account">
        <div className="row wrap">
          <label className="file">
            <input type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
            {fileName || "Choose trade history CSV…"}
          </label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required aria-label="Account">
            <option value="">Into investment account…</option>
            {investmentAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            value={profileId}
            onChange={(e) => {
              setProfileId(e.target.value);
              setMapping(null);
            }}
            aria-label="Saved mapping"
          >
            <option value="">Guess the columns</option>
            {profiles.map((pr) => (
              <option key={pr.id} value={pr.id}>
                Saved mapping: {pr.name}
              </option>
            ))}
          </select>
        </div>
        {investmentAccounts.length === 0 && (
          <Empty>
            Add a brokerage or retirement account first (<Link to="/accounts">Accounts page</Link>).
          </Empty>
        )}
        <p className="muted small">
          Buys, sells, dividends, reinvestments, fees, splits and transfers. Re-importing the same file changes nothing; rows you edited by hand are kept. Cash deposits become transfers (and, for accounts without a bank feed, ledger rows
          that count toward savings goals).
        </p>
      </Card>

      {!p && preview.isLoading && <p className="muted">Reading file…</p>}
      <ErrorText error={preview.error} />

      {p && (
        <Card key={`mapping-${fileKey}`} title="2. Column mapping">
          {p.sampleRows.length > 0 && (
            <div className="scroll">
              <table className="table small">
                <tbody>
                  {p.sampleRows.slice(0, 4).map((r, i) => (
                    <tr key={i}>
                      {r.map((c, j) => (
                        <td key={j}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!mapping ? (
            <>
              <p className="error">Could not guess the date, action and symbol columns. Pick them below.</p>
              <button type="button" className="secondary" onClick={() => setMapping(handBuiltTradesMapping(headers))}>
                Build a mapping by hand
              </button>
            </>
          ) : (
            <>
              <TradesMappingEditor
                mapping={mapping}
                headers={headers}
                accountFilterValue={accountFilterValue}
                filterValues={p.filterValues}
                onChange={(m) => {
                  setMapping(m);
                  setChoices(new Map());
                }}
                onAccountFilterValue={setAccountFilterValue}
              />
              {issues.length > 0 && (
                <ul className="errors">
                  {issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Card>
      )}

      {p && mapping && issues.length === 0 && (
        <Fragment key={`preview-${fileKey}`}>
          <Card title="Actions found" actions={<span className="muted small">{actions.length} distinct action{actions.length === 1 ? "" : "s"}</span>}>
            {unknownText && <p className="imp-bar imp-bar-bad">{unknownText}</p>}
            <div className="scroll">
              <table className="table small imp-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Sample</th>
                    <th className="num">Rows</th>
                    <th>Read as</th>
                  </tr>
                </thead>
                <tbody>
                  {actions.map((a) => (
                    <tr key={a.key} className={a.kind === null ? "imp-unknown" : ""}>
                      <td>
                        <code>{a.key}</code>
                        {a.fromProfile && <Badge tone="neutral">saved</Badge>}
                      </td>
                      <td className="muted small">{a.sample}</td>
                      <td className="num">{a.count}</td>
                      <td>
                        <select
                          value={mapping.actionMap[a.key] ?? (a.kind ?? "")}
                          onChange={(e) => setMapping(setActionKind(mapping, a.key, e.target.value === "" ? null : (e.target.value as TradeKind)))}
                          aria-label={`Kind of ${a.key}`}
                          className={a.kind === null ? "unset" : ""}
                        >
                          <option value="">{a.kind === null ? "— not recognised: choose —" : "— as recognised —"}</option>
                          {TRADE_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {tradeKindLabel(k)}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">An entry here is remembered with the saved mapping; a key matches any action it is a prefix of ("journaled" covers every journal variant). Nothing is imported silently.</p>
          </Card>

          <Card
            title="3. Preview"
            actions={
              <span className="muted small">
                {p.totalRows} row{p.totalRows === 1 ? "" : "s"} · {p.duplicateCount} already imported · {p.changedCount} changed · {p.userEditedCount} edited by hand · {p.errors.length} unreadable
                {preview.isFetching ? " · updating…" : ""}
              </span>
            }
          >
            {rowOrderText(p.rowOrder) && <p className="muted small">{rowOrderText(p.rowOrder)}</p>}
            {p.errors.length > 0 && (
              <ul className="errors">
                {p.errors.slice(0, 50).map((e) => (
                  <li key={e.rowIndex}>
                    row {e.rowIndex + 1}: {e.message}
                  </li>
                ))}
              </ul>
            )}
            {splitRowsNeedingRatio.length > 0 && <p className="imp-bar imp-bar-warn">{splitRowsNeedingRatio.length} split row{splitRowsNeedingRatio.length === 1 ? "" : "s"} without a ratio: enter new : old on the row.</p>}
            <div className="scroll">
              <table className="table small imp-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Security</th>
                    <th className="num">Quantity</th>
                    <th className="num">Price</th>
                    <th className="num">Fee</th>
                    <th className="num">Amount</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <Fragment key={`${g.date}-${g.rows[0]?.rowIndex}-${g.rows[0]?.sequence}`}>
                      <tr className="imp-date">
                        <td colSpan={8}>{shortDate(g.date)}</td>
                      </tr>
                      {g.rows.map((t) => (
                        <TradeRow key={`${t.rowIndex}-${t.sequence}-${t.externalId}`} t={t} choice={choices.get(t.rowIndex)} securities={securities.data ?? []} onChoice={(patch) => patchChoice(t.rowIndex, patch)} />
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {p.trades.length > 100 && !showAll && (
              <button type="button" className="link small" onClick={() => setShowAll(true)}>
                show all {p.trades.length} rows
              </button>
            )}
            {reinvestHint && (
              <p className="muted small">Some reinvest rows have no dividend row on the same date. If this institution lists one row per reinvestment, set "Reinvest rows" to dividend + purchase so each lands as two rows (a dividend and a purchase).</p>
            )}
            {p.skipped.length > 0 && (
              <details className="imp-skipped">
                <summary className="muted small">{p.skipped.length} row{p.skipped.length === 1 ? "" : "s"} skipped</summary>
                <ul className="muted small">
                  {p.skipped.slice(0, 50).map((s) => (
                    <li key={s.rowIndex}>
                      row {s.rowIndex + 1}: {s.reason.replace(/_/g, " ")} · {s.text}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="row wrap imp-commit">
              <label className="inline">
                <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> save this mapping for
              </label>
              <input placeholder="Institution name" value={saveName} onChange={(e) => setSaveName(e.target.value)} disabled={!save} />
              <button type="button" onClick={onCommit} disabled={!canCommit} title={p.unknownActions > 0 ? "Map or skip every unrecognised action first" : undefined}>
                {commit.isPending ? "Importing…" : tradesCommitLabel(p.totalRows, p.duplicateCount)}
              </button>
            </div>
            <ErrorText error={commit.error} />
            {commit.data && (
              <>
                <p className="notice">
                  {tradesResultText(commit.data)}{" "}
                  {commit.data.securitiesCreated > 0 && (
                    <Link to="/investments/securities?chip=review">
                      Review {commit.data.securitiesCreated} new securit{commit.data.securitiesCreated === 1 ? "y" : "ies"}
                    </Link>
                  )}{" "}
                  <Link to={`/investments/accounts/${accountId}?tab=trades`}>Open the account's trades</Link>
                </p>
                {commit.data.warnings.length > 0 && (
                  <ul className="errors">
                    {commit.data.warnings.slice(0, 20).map((w, i) => (
                      <li key={i}>
                        {w.rowIndex !== undefined ? `row ${w.rowIndex + 1}: ` : ""}
                        {w.message}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Card>
        </Fragment>
      )}
    </>
  );
}

function TradeRow({ t, choice, securities, onChoice }: { t: MappedTradeView; choice: RowChoice | undefined; securities: readonly SecurityView[]; onChoice: (patch: Partial<Omit<RowChoice, "rowIndex">>) => void }) {
  const marker = tradeRowMarker(t);
  const ledger = ledgerMatchText(t);
  const derived = (field: "amount" | "price") => (t.derived.includes(field) ? "imp-derived" : "");
  const needsRatio = t.type === "split" && (t.splitNum === null || t.splitDen === null);
  const [num, setNum] = useState(choice?.split ? String(choice.split.num) : "");
  const [den, setDen] = useState(choice?.split ? String(choice.split.den) : "");
  const applyRatio = (n: string, d: string) => {
    setNum(n);
    setDen(d);
    const nn = Number(n);
    const dd = Number(d);
    if (Number.isInteger(nn) && Number.isInteger(dd) && nn >= 1 && dd >= 1) onChoice({ split: { num: nn, den: dd } });
    else onChoice({ split: undefined });
  };
  return (
    <tr className={t.duplicate && !t.changed ? "muted" : ""}>
      <td className="muted small">{t.sequence > 0 ? `#${t.sequence + 1}` : ""}</td>
      <td>
        <Badge tone={tradeTypeTone(t.type)}>{tradeTypeLabel(t.type)}</Badge>
        {t.transferDirection && <span className="muted small"> {t.transferDirection}</span>}
        {t.type === "split" && !needsRatio && <span className="muted small"> {t.splitNum}:{t.splitDen}</span>}
        {needsRatio && (
          <span className="row imp-ratio">
            <input inputMode="numeric" value={num} onChange={(e) => applyRatio(e.target.value, den)} aria-label="New shares" placeholder="new" />
            <span className="muted">:</span>
            <input inputMode="numeric" value={den} onChange={(e) => applyRatio(num, e.target.value)} aria-label="Old shares" placeholder="old" />
          </span>
        )}
      </td>
      <td>
        {t.security ? (
          <SecurityChoiceCell security={t.security} choice={choice?.security} securities={securities} onChange={(security) => onChoice({ security })} />
        ) : (
          <span className="muted">cash</span>
        )}
        <div className="muted small">{t.rawDescription}</div>
      </td>
      <td className="num">{t.quantity === null ? "" : formatQuantity(t.quantity, 4)}</td>
      <td className={`num ${derived("price")}`}>{t.price === null ? "" : formatQuantity(t.price, 4)}</td>
      <td className="num muted">{BigInt(t.feeCents) === 0n ? "" : money(t.feeCents)}</td>
      <td className={`num ${derived("amount")} ${BigInt(t.amountCents) < 0n ? "neg" : BigInt(t.amountCents) > 0n ? "pos" : ""}`}>{signedMoney(t.amountCents)}</td>
      <td className="imp-flags">
        {marker && <Badge tone={marker.tone}>{marker.text}</Badge>}
        {ledger && <span className="muted small">{ledger}</span>}
        {t.warnings.length > 0 && (
          <span title={t.warnings.map(previewWarningText).join("; ")}>
            <Badge tone="warn">{t.warnings.length} note{t.warnings.length === 1 ? "" : "s"}</Badge>
          </span>
        )}
      </td>
    </tr>
  );
}
