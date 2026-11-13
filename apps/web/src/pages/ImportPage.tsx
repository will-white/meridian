import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { CsvDateFormat, type AccountView, type ConnectionView, type CsvKind, type CsvMappingInput, type CsvPreviewResponse, type ImportResult, type UndoImportResult } from "@meridian/shared";
import { api } from "../lib/api.js";
import { money, shortDate } from "../lib/format.js";
import { bankPreviewBody, bankResultText, CSV_KINDS, csvKindFromParam, type BankPreviewBody } from "../lib/importMapping.js";
import { undoResultText } from "../lib/ledgerCorrections.js";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";
import { PositionsImport } from "../components/import/PositionsImport.js";
import { TradesImport } from "../components/import/TradesImport.js";
import { nextFileKey, PREVIEW_KEY } from "../components/import/previewQuery.js";
import { useCsvPreview } from "../components/import/useCsvPreview.js";
import "./investments/investments.css";
import "../components/import/import.css";

type Mapping = CsvMappingInput;
type BankCommitBody = { accountId: string; csvText: string; mapping: Mapping; saveProfile?: { id?: string; name: string } };

/**
 * Import a CSV: a kind switch (`?kind=bank|positions|trades`) over three
 * flows sharing the file → mapping → preview → commit skeleton. Bank
 * transactions are the Phase 1 flow; brokerage positions and trade history
 * are the Phase 3 flows (imports design §5), which only accept investment
 * accounts and the saved profiles of their own kind.
 */
export function ImportPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const kind = csvKindFromParam(searchParams.get("kind"));
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts") });
  const connections = useQuery({ queryKey: ["connections"], queryFn: () => api<ConnectionView[]>("/connections") });
  const setKind = (next: CsvKind) =>
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (next === "bank") n.delete("kind");
        else n.set("kind", next);
        return n;
      },
      { replace: true },
    );
  const titles: Record<CsvKind, string> = { bank: "Import a bank CSV", positions: "Import brokerage positions", trades: "Import trade history" };
  return (
    <>
      <div className="row space wrap">
        <h1>{titles[kind]}</h1>
        <div className="inv-seg imp-kinds" role="group" aria-label="File kind">
          {CSV_KINDS.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <ErrorText error={accounts.error} />
      <ErrorText error={connections.error} />
      {kind === "bank" && <BankImport accounts={accounts.data ?? []} connections={connections.data ?? []} />}
      {kind === "positions" && <PositionsImport key="positions" accounts={accounts.data ?? []} connections={connections.data ?? []} />}
      {kind === "trades" && <TradesImport key="trades" accounts={accounts.data ?? []} connections={connections.data ?? []} />}
    </>
  );
}

/**
 * The Phase 1 bank-transactions flow: file, account and saved profile → the
 * mapping editor (the server's guess, the profile's mapping, or a hand-built
 * start) → the preview with the rows already imported marked → commit. The
 * preview is a query keyed by its request (`useCsvPreview`), so it runs once
 * per change and the cards stay on screen while it does.
 */
function BankImport({ accounts: accountList, connections: connectionList }: { accounts: readonly AccountView[]; connections: readonly ConnectionView[] }) {
  const qc = useQueryClient();
  const profiles = connectionList.filter((c) => c.type === "csv" && c.csvKind === "bank" && c.csvMapping);

  const [accountId, setAccountId] = useState("");
  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [profileId, setProfileId] = useState("");
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [saveName, setSaveName] = useState("");
  const [save, setSave] = useState(false);
  /** One per chosen file: keys the preview. */
  const [fileKey, setFileKey] = useState(0);

  const preview = useCsvPreview<BankPreviewBody, Mapping, CsvPreviewResponse>({
    path: "/import/csv/preview",
    fileKey,
    mapping,
    onMapping: setMapping,
    bodyFor: (m) => bankPreviewBody({ csvText, accountId, profileId, mapping: m }),
  });
  const commit = useMutation({
    // `alreadyImported` is the preview's count at this moment; the result line needs it after the preview has run again.
    mutationFn: (v: { body: BankCommitBody; alreadyImported: number }) => api<ImportResult>("/import/csv/commit", { method: "POST", body: v.body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["transactions"] });
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: ["connections"] });
      // The rows just imported are in the ledger now: the preview runs again and marks them.
      void qc.invalidateQueries({ queryKey: PREVIEW_KEY });
    },
  });

  // Audit a5-ingest-transfers-09: the import just committed can be taken back out.
  const undo = useMutation({
    mutationFn: (importLogId: string) => api<UndoImportResult>(`/import/csv/${importLogId}/undo`, { method: "POST", body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["transactions"] });
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: PREVIEW_KEY });
    },
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    // Read first, then change everything in one render: the old file is never previewed under the new file's key.
    const text = await file.text();
    setFileName(file.name);
    setMapping(null);
    setFileKey(nextFileKey());
    commit.reset();
    undo.reset();
    setCsvText(text);
  };

  const p = preview.shown;
  const headers = p?.headers ?? [];
  const columnOptions = headers.map((h, i) => (
    <option key={i} value={p?.mapping?.hasHeader === false ? i : h}>
      {h}
    </option>
  ));
  const setM = (patch: Partial<Mapping>) => mapping && setMapping({ ...mapping, ...patch });
  /** The server answered the current request and found no mapping: the owner builds one. */
  const noGuess = preview.current && p?.mapping === null;

  return (
    <>
      <Card title="1. File and account">
        <div className="row wrap">
          <label className="file">
            <input type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
            {fileName || "Choose CSV…"}
          </label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required aria-label="Account">
            <option value="">Into account…</option>
            {accountList
              .filter((a) => !a.closed)
              .map((a) => (
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
        {accountList.length === 0 && <Empty>Create an account first (Accounts page).</Empty>}
      </Card>

      {preview.reading && <p className="muted">Reading file…</p>}
      <ErrorText error={preview.error} />

      {p && (
        <Card title="2. Column mapping">
          {!mapping && noGuess && <p className="error">Could not guess the date and description columns. Pick them below.</p>}
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
          {(mapping || noGuess) && <MappingEditor mapping={mapping} headers={headers} onChange={setMapping} columnOptions={columnOptions} setM={setM} />}
        </Card>
      )}

      {p && mapping && (
        <Card
          title="3. Preview"
          actions={
            <span className="muted">
              {p.totalRows} rows · {p.duplicateCount} already imported · {p.errors.length} unreadable{preview.updating ? " · updating…" : ""}
            </span>
          }
        >
          {p.errors.length > 0 && (
            <ul className="errors">
              {p.errors.slice(0, 5).map((e) => (
                <li key={e.rowIndex}>
                  row {e.rowIndex + 1}: {e.message}
                </li>
              ))}
            </ul>
          )}
          <table className="table small">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th className="num">Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {p.rows.slice(0, 25).map((r) => (
                <tr key={r.rowIndex} className={r.duplicate ? "muted" : ""}>
                  <td>{shortDate(r.date)}</td>
                  <td>
                    {r.description}
                    {r.memo ? <span className="muted"> · {r.memo}</span> : null}
                  </td>
                  <td className={`num ${r.amountCents.startsWith("-") ? "neg" : "pos"}`}>{money(r.amountCents)}</td>
                  <td>{r.duplicate && <Badge tone="neutral">duplicate</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row wrap">
            <label className="inline">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> save this mapping for
            </label>
            <input placeholder="Institution name" value={saveName} onChange={(e) => setSaveName(e.target.value)} disabled={!save} />
            <button
              type="button"
              onClick={() =>
                commit.mutate({
                  body: {
                    accountId,
                    csvText,
                    mapping,
                    ...(save && saveName.trim() ? { saveProfile: { ...(profileId ? { id: profileId } : {}), name: saveName.trim() } } : {}),
                  },
                  alreadyImported: p.duplicateCount,
                })
              }
              // Only a preview that answers what is on screen is committed.
              disabled={!accountId || !preview.current || commit.isPending || p.totalRows === 0}
            >
              {commit.isPending ? "Importing…" : `Import ${p.totalRows - p.duplicateCount} new transaction${p.totalRows - p.duplicateCount === 1 ? "" : "s"}`}
            </button>
          </div>
          <ErrorText error={commit.error} />
          {commit.data && (
            <p className="notice">
              {bankResultText(commit.data, commit.variables?.alreadyImported ?? 0)}{" "}
              {commit.data.importLogId && !undo.data && (
                <button
                  className="link"
                  disabled={undo.isPending}
                  onClick={() => {
                    if (window.confirm("Take this import back out? The rows it added are deleted; the file can be imported again.")) undo.mutate(commit.data!.importLogId!);
                  }}
                >
                  Undo this import
                </button>
              )}
            </p>
          )}
          {undo.data && <p className="notice">{undoResultText(undo.data)}</p>}
          <ErrorText error={undo.error} />
        </Card>
      )}
    </>
  );
}

function MappingEditor({
  mapping,
  headers,
  onChange,
  columnOptions,
  setM,
}: {
  mapping: Mapping | null;
  headers: string[];
  onChange: (m: Mapping) => void;
  columnOptions: React.ReactNode;
  setM: (patch: Partial<Mapping>) => void;
}) {
  if (!mapping) {
    return (
      <button
        className="secondary"
        onClick={() =>
          onChange({
            hasHeader: true,
            date: { column: headers[0] ?? 0, format: "MM/DD/YYYY" },
            description: { column: headers[1] ?? 1 },
            amount: { mode: "single", column: headers[headers.length - 1] ?? 2, invert: false },
          })
        }
      >
        Build a mapping by hand
      </button>
    );
  }
  const col = (c: string | number) => String(c);
  return (
    <div className="grid2">
      <label>
        Date column
        <select value={col(mapping.date.column)} onChange={(e) => setM({ date: { ...mapping.date, column: e.target.value } })}>
          {columnOptions}
        </select>
      </label>
      <label>
        Date format
        <select value={mapping.date.format} onChange={(e) => setM({ date: { ...mapping.date, format: e.target.value as Mapping["date"]["format"] } })}>
          {CsvDateFormat.options.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label>
        Description column
        <select value={col(mapping.description.column)} onChange={(e) => setM({ description: { column: e.target.value } })}>
          {columnOptions}
        </select>
      </label>
      <label>
        Amount layout
        <select
          value={mapping.amount.mode}
          onChange={(e) =>
            setM({
              amount:
                e.target.value === "single"
                  ? { mode: "single", column: headers[headers.length - 1] ?? 0, invert: false }
                  : { mode: "split", debitColumn: headers[headers.length - 2] ?? 0, creditColumn: headers[headers.length - 1] ?? 1 },
            })
          }
        >
          <option value="single">One signed amount column</option>
          <option value="split">Separate debit and credit columns</option>
        </select>
      </label>
      {mapping.amount.mode === "single" ? (
        <>
          <label>
            Amount column
            <select value={col(mapping.amount.column)} onChange={(e) => mapping.amount.mode === "single" && setM({ amount: { ...mapping.amount, column: e.target.value } })}>
              {columnOptions}
            </select>
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={mapping.amount.invert ?? false}
              onChange={(e) => mapping.amount.mode === "single" && setM({ amount: { ...mapping.amount, invert: e.target.checked } })}
            />{" "}
            outflows are positive in this file
          </label>
        </>
      ) : (
        <>
          <label>
            Debit (money out) column
            <select
              value={col(mapping.amount.debitColumn)}
              onChange={(e) => mapping.amount.mode === "split" && setM({ amount: { ...mapping.amount, debitColumn: e.target.value } })}
            >
              {columnOptions}
            </select>
          </label>
          <label>
            Credit (money in) column
            <select
              value={col(mapping.amount.creditColumn)}
              onChange={(e) => mapping.amount.mode === "split" && setM({ amount: { ...mapping.amount, creditColumn: e.target.value } })}
            >
              {columnOptions}
            </select>
          </label>
        </>
      )}
      <label>
        Memo column <span className="muted">(optional)</span>
        <select
          value={mapping.memo ? col(mapping.memo.column) : ""}
          onChange={(e) => {
            const { memo: _drop, ...rest } = mapping;
            onChange(e.target.value ? { ...rest, memo: { column: e.target.value } } : rest);
          }}
        >
          <option value="">—</option>
          {columnOptions}
        </select>
      </label>
      <label>
        Bank transaction id column <span className="muted">(optional)</span>
        <select
          value={mapping.externalId ? col(mapping.externalId.column) : ""}
          onChange={(e) => {
            const { externalId: _drop, ...rest } = mapping;
            onChange(e.target.value ? { ...rest, externalId: { column: e.target.value } } : rest);
          }}
        >
          <option value="">— (dedupe by date, amount and description)</option>
          {columnOptions}
        </select>
      </label>
      <label className="inline">
        <input type="checkbox" checked={mapping.hasHeader ?? true} onChange={(e) => setM({ hasHeader: e.target.checked })} /> first row is a header
      </label>
    </div>
  );
}
