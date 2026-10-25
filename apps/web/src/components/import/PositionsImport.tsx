import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { isInvestmentAccountType } from "@meridian/shared";
import type { AccountView, ConnectionView, PositionsCommitBody, PositionsCsvMapping, PositionsImportResult, PositionsPreviewBody, PositionsPreviewResponse, RowChoice, SecurityChoice, SecurityView } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { money } from "../../lib/format.js";
import { formatQuantity } from "../../lib/investments.js";
import { dollarsToCentsSigned } from "../../lib/investmentForms.js";
import { handBuiltPositionsMapping, positionsCommitLabel, positionsMappingIssues, positionsResultText, previewWarningText, reconciliationLine, snapshotBar } from "../../lib/importMapping.js";
import { localToday } from "../../lib/plan.js";
import { Badge, Card, Empty, ErrorText } from "../ui.js";
import { invalidateInvestments, useIsViewer } from "../investments/queries.js";
import { PositionsMappingEditor } from "./PositionsMappingEditor.js";
import { previewQueryOptions } from "./previewQuery.js";
import { SecurityChoiceCell } from "./SecurityChoiceCell.js";

/**
 * Brokerage positions import (imports design §3.6–§3.7, §5): file, investment
 * account and saved positions profile → the mapping editor (the server's
 * guess, a hand-built start when it has none) → the preview with security
 * badges and choices, the reconciliation line against the Bridge balance,
 * the snapshot bar and the skipped rows → commit (`POST /import/positions/commit`
 * with the optional statement total, seams C40) → the result line.
 */
export function PositionsImport({ accounts, connections }: { accounts: readonly AccountView[]; connections: readonly ConnectionView[] }) {
  const viewer = useIsViewer();
  if (viewer) return <ImportsAreOwnerOnly what="brokerage positions" />;
  return <PositionsImportEditor accounts={accounts} connections={connections} />;
}

/** The viewer role (plan decision 19): the preview and the commit are both owner-only writes, so the flow is not shown. */
export function ImportsAreOwnerOnly({ what }: { what: string }) {
  return (
    <Card>
      <Empty>
        Importing {what} is for the owner role. Browse the <Link to="/investments">Portfolio</Link> and each account's <Link to="/accounts">positions and trades</Link> instead.
      </Empty>
    </Card>
  );
}

function PositionsImportEditor({ accounts, connections }: { accounts: readonly AccountView[]; connections: readonly ConnectionView[] }) {
  const qc = useQueryClient();
  const today = useMemo(() => localToday(), []);
  const investmentAccounts = accounts.filter((a) => isInvestmentAccountType(a.type) && !a.closed);
  const profiles = connections.filter((c) => c.type === "csv" && c.csvKind === "positions" && c.positionsMapping);
  const securities = useQuery({ queryKey: ["securities", "all"], queryFn: () => api<SecurityView[]>("/investments/securities") });

  const [accountId, setAccountId] = useState("");
  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [profileId, setProfileId] = useState("");
  const [mapping, setMapping] = useState<PositionsCsvMapping | null>(null);
  const [asOfDate, setAsOfDate] = useState("");
  const [accountFilterValue, setAccountFilterValue] = useState("");
  const [choices, setChoices] = useState<ReadonlyMap<number, RowChoice>>(new Map());
  const [setBalance, setSetBalance] = useState<boolean | null>(null);
  const [statementTotal, setStatementTotal] = useState("");
  const [save, setSave] = useState(false);
  const [saveName, setSaveName] = useState("");
  /** Bumped per chosen file: keys the preview and remounts the cards for a new file. */
  const [fileKey, setFileKey] = useState(0);

  const commit = useMutation({
    mutationFn: (body: PositionsCommitBody) => api<PositionsImportResult>("/import/positions/commit", { method: "POST", body }),
    onSuccess: () => {
      invalidateInvestments(qc);
      void qc.invalidateQueries({ queryKey: ["connections"] });
      void qc.invalidateQueries({ queryKey: ["snapshots"] });
      void qc.invalidateQueries({ queryKey: ["prices"] });
    },
  });

  // The statement date is a `type="date"` input (a complete date or ""), so the issues and the body read the same value: no debounce.
  const issues = mapping ? positionsMappingIssues(mapping, asOfDate) : [];
  const choiceList = useMemo(() => [...choices.values()], [choices]);
  const previewBody: PositionsPreviewBody | null = useMemo(() => {
    if (!csvText || !accountId) return null;
    if (mapping && issues.length > 0) return null;
    const body: PositionsPreviewBody = { csvText, accountId, choices: choiceList };
    if (mapping) body.mapping = mapping;
    else if (profileId) body.profileId = profileId;
    if (asOfDate) body.asOfDate = asOfDate;
    if (accountFilterValue) body.accountFilterValue = accountFilterValue;
    return body;
  }, [csvText, accountId, mapping, profileId, asOfDate, accountFilterValue, choiceList, issues.length]);

  // The preview re-runs whenever the file, account, profile, mapping, date, filter or choices change;
  // the last response stays on screen meanwhile (a mutation would unmount the cards per keystroke).
  const preview = useQuery(previewQueryOptions<PositionsPreviewBody, PositionsPreviewResponse>("/import/positions/preview", previewBody, fileKey));
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
    setSetBalance(null);
    setStatementTotal("");
    setFileKey((k) => k + 1);
    commit.reset();
    setCsvText(await file.text());
  };
  const setChoice = (rowIndex: number, security: SecurityChoice | undefined) =>
    setChoices((prev) => {
      const next = new Map(prev);
      if (security === undefined) next.delete(rowIndex);
      else next.set(rowIndex, { rowIndex, security });
      return next;
    });

  const p = preview.data;
  const headers = p?.headers ?? [];
  const line = p ? reconciliationLine(p) : null;
  const bar = p ? snapshotBar(p) : null;
  const balanceDefault = p?.setBalanceDefault ?? true;
  const willSetBalance = setBalance ?? balanceDefault;
  const statementTotalCents = statementTotal.trim() === "" ? null : dollarsToCentsSigned(statementTotal);
  const totalValid = statementTotal.trim() === "" || (statementTotalCents !== null && statementTotalCents >= 0n);
  const canCommit = Boolean(p && !preview.isPlaceholderData && mapping && accountId && issues.length === 0 && p.positions.length > 0 && !(bar?.blocks) && totalValid && !commit.isPending);

  const onCommit = () => {
    if (!p || !mapping || !previewBody) return;
    const body: PositionsCommitBody = { ...previewBody, mapping, today, setBalance: willSetBalance };
    if (statementTotalCents !== null) body.statementTotalCents = statementTotalCents.toString();
    if (save && saveName.trim()) body.saveProfile = { ...(profileId ? { id: profileId } : {}), name: saveName.trim() };
    commit.mutate(body);
  };

  return (
    <>
      <Card title="1. File and account">
        <div className="row wrap">
          <label className="file">
            <input type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
            {fileName || "Choose positions CSV…"}
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
        <p className="muted small">A statement's positions on one date: symbol or name, quantity, price or value, and the cost basis when the file has it. The snapshot is dated by the file or by the date you enter, never by the clock.</p>
      </Card>

      {!p && preview.isLoading && <p className="muted">Reading file…</p>}
      <ErrorText error={preview.error} />

      {p && (
        <Card key={`mapping-${fileKey}`} title="2. Column mapping" actions={<span className="muted small">{p.rowsRead} data rows</span>}>
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
              <p className="error">Could not guess the symbol and value columns. Pick them below.</p>
              <button type="button" className="secondary" onClick={() => setMapping(handBuiltPositionsMapping(headers))}>
                Build a mapping by hand
              </button>
            </>
          ) : (
            <>
              <PositionsMappingEditor
                mapping={mapping}
                headers={headers}
                asOfDate={asOfDate}
                accountFilterValue={accountFilterValue}
                filterValues={p.filterValues}
                onChange={(m) => {
                  setMapping(m);
                  setChoices(new Map());
                }}
                onAsOfDate={setAsOfDate}
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
        <Card
          key={`preview-${fileKey}`}
          title={`3. Preview${p.asOf ? ` · positions as of ${p.asOf}` : ""}`}
          actions={
            <span className="muted small">
              {p.positions.length} position{p.positions.length === 1 ? "" : "s"} · {p.skipped.length} skipped · {p.errors.length} unreadable{preview.isFetching ? " · updating…" : ""}
            </span>
          }
        >
          {bar && <p className={`imp-bar imp-bar-${bar.tone}`}>{bar.text}</p>}
          {p.errors.length > 0 && (
            <ul className="errors">
              {p.errors.slice(0, 50).map((e) => (
                <li key={e.rowIndex}>
                  row {e.rowIndex + 1}: {e.message}
                </li>
              ))}
            </ul>
          )}
          <div className="scroll">
            <table className="table small imp-table">
              <thead>
                <tr>
                  <th>Security</th>
                  <th className="num">Quantity</th>
                  <th className="num">Price</th>
                  <th className="num">Value</th>
                  <th className="num">Cost</th>
                  <th>Now stored</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {p.positions.map((row) => (
                  <tr key={row.rowIndex}>
                    <td>
                      <SecurityChoiceCell security={row.security} choice={choices.get(row.rowIndex)?.security} securities={securities.data ?? []} onChange={(c) => setChoice(row.rowIndex, c)} />
                    </td>
                    <td className="num">{row.quantity === null ? <span className="muted">value only</span> : formatQuantity(row.quantity, 4)}</td>
                    <td className="num">{row.price === null ? "—" : formatQuantity(row.price, 4)}</td>
                    <td className="num">{money(row.valueCents)}</td>
                    <td className="num muted">{row.costBasisCents === null ? "—" : money(row.costBasisCents)}</td>
                    <td className="muted small">{row.existing ? `${row.existing.quantity === null ? "value only" : formatQuantity(row.existing.quantity, 4)} · ${money(row.existing.valueCents)}` : "—"}</td>
                    <td>
                      {row.warnings.length > 0 && (
                        <span title={row.warnings.map(previewWarningText).join("; ")}>
                          <Badge tone="warn">{row.warnings.length} note{row.warnings.length === 1 ? "" : "s"}</Badge>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>
                    <strong>Total</strong>
                  </td>
                  <td className="num">
                    <strong>{money(p.totalValueCents)}</strong>
                  </td>
                  <td colSpan={3} className="muted small">
                    {BigInt(p.pendingActivityCents) !== 0n ? `pending activity ${money(p.pendingActivityCents)} not imported` : ""}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          {line && <p className={`imp-line tone-${line.tone}`}>{line.text}</p>}
          {p.skipped.length > 0 && (
            <details className="imp-skipped">
              <summary className="muted small">{p.skipped.length} row{p.skipped.length === 1 ? "" : "s"} skipped</summary>
              <ul className="muted small">
                {p.skipped.slice(0, 50).map((s) => (
                  <li key={s.rowIndex}>
                    row {s.rowIndex + 1}: {s.reason.replace(/_/g, " ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="row wrap imp-commit">
            <label className="inline" title={balanceDefault ? "This account has no SimpleFIN feed: the balance comes from the positions (or the statement total)" : "The SimpleFIN balance stays unless you ask"}>
              <input type="checkbox" checked={willSetBalance} onChange={(e) => setSetBalance(e.target.checked)} /> also set the account balance
            </label>
            <label className="inline">
              statement total
              <input inputMode="decimal" placeholder={`Σ ${money(p.totalValueCents)}`} value={statementTotal} onChange={(e) => setStatementTotal(e.target.value)} disabled={!willSetBalance} className="imp-total" aria-label="Statement total" />
            </label>
            {!totalValid && <span className="error small">not a dollar amount</span>}
          </div>
          <div className="row wrap imp-commit">
            <label className="inline">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> save this mapping for
            </label>
            <input placeholder="Institution name" value={saveName} onChange={(e) => setSaveName(e.target.value)} disabled={!save} />
            <button type="button" onClick={onCommit} disabled={!canCommit}>
              {commit.isPending ? "Importing…" : positionsCommitLabel(p.positions.length, p.asOf)}
            </button>
          </div>
          <ErrorText error={commit.error} />
          {commit.data && (
            <p className="notice">
              {positionsResultText(commit.data)}{" "}
              {commit.data.securitiesCreated > 0 && (
                <Link to="/investments/securities?chip=review">
                  Review {commit.data.securitiesCreated} new securit{commit.data.securitiesCreated === 1 ? "y" : "ies"}
                </Link>
              )}{" "}
              <Link to={`/investments/accounts/${accountId}`}>Open the account</Link>
            </p>
          )}
        </Card>
      )}
    </>
  );
}
