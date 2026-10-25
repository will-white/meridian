import { CsvDateFormat, type PositionsCsvMapping } from "@meridian/shared";
import { columnValue, POSITIONS_COLUMNS, setPositionsAsOf, setPositionsColumn } from "../../lib/importMapping.js";

/**
 * The positions mapping editor (imports design §5): one select per field in
 * the bank editor's style, the as-of date as a column with a format or as a
 * date typed here when the file has none, and the account filter listing the
 * file's distinct values when that column is set.
 */
export function PositionsMappingEditor({
  mapping,
  headers,
  asOfDate,
  accountFilterValue,
  filterValues,
  onChange,
  onAsOfDate,
  onAccountFilterValue,
}: {
  mapping: PositionsCsvMapping;
  headers: readonly string[];
  asOfDate: string;
  accountFilterValue: string;
  filterValues: readonly string[];
  onChange: (m: PositionsCsvMapping) => void;
  onAsOfDate: (date: string) => void;
  onAccountFilterValue: (value: string) => void;
}) {
  const options = headers.map((h, i) => (
    <option key={i} value={mapping.hasHeader ? h : i}>
      {h}
    </option>
  ));
  const asOfColumn = mapping.asOf.mode === "column" ? columnValue(mapping.asOf.column) : "";
  const asOfFormat = mapping.asOf.mode === "column" ? mapping.asOf.format : "MM/DD/YYYY";
  return (
    <div className="grid2 imp-mapping">
      <label>
        Statement date column
        <select value={asOfColumn} onChange={(e) => onChange(setPositionsAsOf(mapping, e.target.value, asOfFormat))}>
          <option value="">— none: enter the date below —</option>
          {options}
        </select>
      </label>
      {mapping.asOf.mode === "column" ? (
        <label>
          Date format
          <select value={asOfFormat} onChange={(e) => onChange(setPositionsAsOf(mapping, asOfColumn, e.target.value as CsvDateFormat))}>
            {CsvDateFormat.options.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label>
          Statement date <span className="muted">(the file has no date column)</span>
          <input type="date" value={asOfDate} onChange={(e) => onAsOfDate(e.target.value)} required />
        </label>
      )}
      {POSITIONS_COLUMNS.map(([key, label, hint]) => (
        <label key={key}>
          {label} <span className="muted">({hint})</span>
          <select value={columnValue(mapping[key]?.column)} onChange={(e) => onChange(setPositionsColumn(mapping, key, e.target.value))}>
            <option value="">—</option>
            {options}
          </select>
        </label>
      ))}
      {mapping.accountFilter && (
        <label>
          Rows of account
          <select value={accountFilterValue} onChange={(e) => onAccountFilterValue(e.target.value)}>
            <option value="">— every row —</option>
            {filterValues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="inline">
        <input type="checkbox" checked={mapping.hasHeader} onChange={(e) => onChange({ ...mapping, hasHeader: e.target.checked })} /> first row is a header
      </label>
      <label>
        Skip rows at the top
        <input type="number" min={0} step={1} value={mapping.skipRows} onChange={(e) => onChange({ ...mapping, skipRows: Math.max(0, Number(e.target.value) || 0) })} className="imp-skip" />
      </label>
    </div>
  );
}
