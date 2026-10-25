import type { AssetClass, SecurityType, SecurityView } from "@meridian/shared";
import { ASSET_CLASSES, assetClassLabel } from "../../lib/investments.js";
import { SECURITY_TYPES, securityLabel, securityTypeLabel } from "../../lib/investmentForms.js";

export interface NewSecurityDraft {
  ticker: string;
  name: string;
  type: SecurityType;
  assetClass: AssetClass;
}

const NEW = "__new__";

/**
 * A security choice for the manual forms: a select over the known securities
 * (cash included for positions) with a "new security…" option that opens
 * ticker, name, type and class inputs, matching `SecurityChoice`'s two kinds.
 */
export function SecurityPicker({
  securityId,
  create,
  securities,
  allowCreate = true,
  includeCash = true,
  label,
  onChange,
}: {
  securityId: string | null;
  create: NewSecurityDraft | null;
  securities: readonly SecurityView[];
  allowCreate?: boolean;
  includeCash?: boolean;
  label: string;
  onChange: (next: { securityId: string | null; create: NewSecurityDraft | null }) => void;
}) {
  const options = securities.filter((s) => !s.archived && (includeCash || s.type !== "cash"));
  const value = securityId ?? (create ? NEW : "");
  const draft = (patch: Partial<NewSecurityDraft>) => onChange({ securityId: null, create: { ...(create ?? { ticker: "", name: "", type: "stock", assetClass: "us_stock" }), ...patch } });
  return (
    <div className="inv-picker">
      <select
        value={value}
        aria-label={label}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") onChange({ securityId: null, create: null });
          else if (v === NEW) onChange({ securityId: null, create: create ?? { ticker: "", name: "", type: "stock", assetClass: "us_stock" } });
          else onChange({ securityId: v, create: null });
        }}
      >
        <option value="">— security —</option>
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {securityLabel(s)}
          </option>
        ))}
        {allowCreate && <option value={NEW}>— new security… —</option>}
      </select>
      {create && (
        <div className="row wrap inv-picker-new">
          <input value={create.ticker} onChange={(e) => draft({ ticker: e.target.value })} placeholder="Ticker (optional)" aria-label={`${label}: new ticker`} className="inv-picker-ticker" />
          <input value={create.name} onChange={(e) => draft({ name: e.target.value })} placeholder="Name" aria-label={`${label}: new name`} className="grow" />
          <select value={create.type} onChange={(e) => draft({ type: e.target.value as SecurityType })} aria-label={`${label}: new type`}>
            {SECURITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {securityTypeLabel(t)}
              </option>
            ))}
          </select>
          <select value={create.assetClass} onChange={(e) => draft({ assetClass: e.target.value as AssetClass })} aria-label={`${label}: new asset class`}>
            {ASSET_CLASSES.map((c) => (
              <option key={c} value={c}>
                {assetClassLabel(c)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
