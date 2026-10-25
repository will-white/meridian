import { CsvDateFormat, type TradesCsvMapping } from "@meridian/shared";
import { columnRef, columnValue, hasFeeColumn, setTradesAmount, setTradesColumn, toggleFeeColumn, TRADES_COLUMNS } from "../../lib/importMapping.js";

/**
 * The trade-history mapping editor (imports design §5): date and action
 * columns, the optional columns, the amount column with its sign and the
 * "amount includes fees" switch, the fee columns multi-select (commission
 * and fees are summed), the reinvest-rows convention (plan decision 6) and
 * the row order. The action map is edited from the preview's "actions found"
 * table, not here.
 */
export function TradesMappingEditor({
  mapping,
  headers,
  accountFilterValue,
  filterValues,
  onChange,
  onAccountFilterValue,
}: {
  mapping: TradesCsvMapping;
  headers: readonly string[];
  accountFilterValue: string;
  filterValues: readonly string[];
  onChange: (m: TradesCsvMapping) => void;
  onAccountFilterValue: (value: string) => void;
}) {
  const options = headers.map((h, i) => (
    <option key={i} value={mapping.hasHeader ? h : i}>
      {h}
    </option>
  ));
  const value = (h: string, i: number): string => (mapping.hasHeader ? h : String(i));
  return (
    <div className="grid2 imp-mapping">
      <label>
        Date column
        <select value={columnValue(mapping.date.column)} onChange={(e) => onChange({ ...mapping, date: { ...mapping.date, column: columnRef(e.target.value, mapping.hasHeader) } })}>
          {options}
        </select>
      </label>
      <label>
        Date format
        <select value={mapping.date.format} onChange={(e) => onChange({ ...mapping, date: { ...mapping.date, format: e.target.value as CsvDateFormat } })}>
          {CsvDateFormat.options.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label>
        Action column <span className="muted">(buy, sell, dividend…; never the description)</span>
        <select value={columnValue(mapping.action.column)} onChange={(e) => onChange({ ...mapping, action: { column: columnRef(e.target.value, mapping.hasHeader) } })}>
          {options}
        </select>
      </label>
      <label>
        Amount column <span className="muted">(net cash; blank derives it from quantity × price)</span>
        <select value={columnValue(mapping.amount?.column)} onChange={(e) => onChange(setTradesAmount(mapping, e.target.value))}>
          <option value="">—</option>
          {options}
        </select>
      </label>
      {mapping.amount && (
        <>
          <label className="inline">
            <input type="checkbox" checked={mapping.amount.invert} onChange={(e) => mapping.amount && onChange({ ...mapping, amount: { ...mapping.amount, invert: e.target.checked } })} /> amounts are signed the other way in
            this file
          </label>
          <label className="inline" title="Off when the amount column is the principal (price × quantity) and fees are listed separately">
            <input type="checkbox" checked={mapping.amountIncludesFees} onChange={(e) => onChange({ ...mapping, amountIncludesFees: e.target.checked })} /> the amount already includes fees
          </label>
        </>
      )}
      {TRADES_COLUMNS.map(([key, label, hint]) => (
        <label key={key}>
          {label} <span className="muted">({hint})</span>
          <select value={columnValue(mapping[key]?.column)} onChange={(e) => onChange(setTradesColumn(mapping, key, e.target.value))}>
            <option value="">—</option>
            {options}
          </select>
        </label>
      ))}
      <fieldset className="imp-fees">
        <legend>Fee columns <span className="muted">(summed: commission and fees)</span></legend>
        <div className="row wrap">
          {headers.map((h, i) => (
            <label key={i} className="inline">
              <input type="checkbox" checked={hasFeeColumn(mapping, value(h, i))} onChange={() => onChange(toggleFeeColumn(mapping, value(h, i)))} /> {h}
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        Reinvest rows
        <select value={mapping.reinvestRows} onChange={(e) => onChange({ ...mapping, reinvestRows: e.target.value as TradesCsvMapping["reinvestRows"] })}>
          <option value="separate">purchase only: the file lists the dividend on its own row</option>
          <option value="combined">dividend + purchase: one row carries both</option>
        </select>
      </label>
      <label>
        Row order
        <select value={mapping.rowOrder} onChange={(e) => onChange({ ...mapping, rowOrder: e.target.value as TradesCsvMapping["rowOrder"] })}>
          <option value="auto">detect from the dates</option>
          <option value="oldest_first">oldest first</option>
          <option value="newest_first">newest first</option>
        </select>
      </label>
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
