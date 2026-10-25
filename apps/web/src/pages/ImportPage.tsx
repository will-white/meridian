import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { CsvDateFormat, type AccountView, type ConnectionView, type CsvKind, type CsvMappingInput, type CsvPreviewResponse, type ImportResult } from "@meridian/shared";
import { api } from "../lib/api.js";
import { money, shortDate } from "../lib/format.js";
import { CSV_KINDS, csvKindFromParam } from "../lib/importMapping.js";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";
import { PositionsImport } from "../components/import/PositionsImport.js";
import { TradesImport } from "../components/import/TradesImport.js";
import "./investments/investments.css";
import "../components/import/import.css";

type Mapping = CsvMappingInput;

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

/** The Phase 1 bank-transactions flow, unchanged apart from reading its accounts and profiles from the page. */
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

  const preview = useMutation({
    mutationFn: (body: { csvText: string; accountId?: string; mapping?: Mapping; profileId?: string }) =>
      api<CsvPreviewResponse>("/import/csv/preview", { method: "POST", body }),
    onSuccess: (res) => {
      if (res.mapping) setMapping(res.mapping);
    },
  });
  const commit = useMutation({
    mutationFn: (body: { accountId: string; csvText: string; mapping: Mapping; saveProfile?: { id?: string; name: string } }) =>
      api<ImportResult>("/import/csv/commit", { method: "POST", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["transactions"] });
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: ["connections"] });
    },
  });

  // Re-run the preview whenever the file, profile, or mapping changes.
  useEffect(() => {
    if (!csvText) return;
    const body: Parameters<typeof preview.mutate>[0] = { csvText };
    if (accountId) body.accountId = accountId;
    if (mapping) body.mapping = mapping;
    else if (profileId) body.profileId = profileId;
    preview.mutate(body);
  }, [csvText, accountId, profileId, mapping]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setMapping(null);
    commit.reset();
    setCsvText(await file.text());
  };

  const headers = preview.data?.headers ?? [];
  const columnOptions = headers.map((h, i) => (
    <option key={i} value={preview.data?.mapping?.hasHeader === false ? i : h}>
      {h}
    </option>
  ));
  const setM = (patch: Partial<Mapping>) => mapping && setMapping({ ...mapping, ...patch });

  return (
    <>
      <Card title="1. File and account">
        <div className="row wrap">
          <label className="file">
            <input type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
            {fileName || "Choose CSV…"}
          </label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
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
          >
            <option value="">Guess the columns</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                Saved mapping: {p.name}
              </option>
            ))}
          </select>
        </div>
        {accountList.length === 0 && <Empty>Create an account first (Accounts page).</Empty>}
      </Card>

      {preview.isPending && <p className="muted">Reading file…</p>}
      <ErrorText error={preview.error} />

      {preview.data && (
        <Card title="2. Column mapping">
          {!mapping && <p className="error">Could not guess the date and description columns. Pick them below.</p>}
          {preview.data.sampleRows.length > 0 && (
            <div className="scroll">
              <table className="table small">
                <tbody>
                  {preview.data.sampleRows.slice(0, 4).map((r, i) => (
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
          <MappingEditor mapping={mapping} headers={headers} onChange={setMapping} columnOptions={columnOptions} setM={setM} />
        </Card>
      )}

      {preview.data && mapping && (
        <Card
          title="3. Preview"
          actions={
            <span className="muted">
              {preview.data.totalRows} rows · {preview.data.duplicateCount} already imported · {preview.data.errors.length} unreadable
            </span>
          }
        >
          {preview.data.errors.length > 0 && (
            <ul className="errors">
              {preview.data.errors.slice(0, 5).map((e) => (
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
              {preview.data.rows.slice(0, 25).map((r) => (
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
              onClick={() =>
                commit.mutate({
                  accountId,
                  csvText,
                  mapping,
                  ...(save && saveName.trim() ? { saveProfile: { ...(profileId ? { id: profileId } : {}), name: saveName.trim() } } : {}),
                })
              }
              disabled={!accountId || commit.isPending || preview.data.totalRows === 0}
            >
              Import {preview.data.totalRows - preview.data.duplicateCount} new transaction{preview.data.totalRows - preview.data.duplicateCount === 1 ? "" : "s"}
            </button>
          </div>
          <ErrorText error={commit.error} />
          {commit.data && (
            <p className="notice">
              Imported {commit.data.created} new, skipped {commit.data.skipped + (preview.data.duplicateCount || 0)} duplicates, paired {commit.data.transfersPaired} transfer
              {commit.data.transfersPaired === 1 ? "" : "s"}.{commit.data.errors.length > 0 ? ` ${commit.data.errors.length} rows could not be read.` : ""}
            </p>
          )}
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
