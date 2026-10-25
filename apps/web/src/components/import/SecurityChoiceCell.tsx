import { useState } from "react";
import type { AssetClass, PreviewSecurityRef, SecurityChoice, SecurityType, SecurityView } from "@meridian/shared";
import { ASSET_CLASSES, assetClassLabel } from "../../lib/investments.js";
import { SECURITY_TYPES, securityLabel, securityTypeLabel } from "../../lib/investmentForms.js";
import { securityBadge } from "../../lib/importMapping.js";
import { Badge } from "../ui.js";

/**
 * A preview row's security (imports design §5): the resolved ticker and name
 * with its badge (`new`, `guessed`, `cash`). A new security offers an inline
 * edit of the suggested name, type and asset class and a "link to existing…"
 * picker; either becomes a `RowChoice.security` the preview and the commit
 * carry. Resolved rows can also be re-pointed at another security.
 */
export function SecurityChoiceCell({
  security,
  choice,
  securities,
  onChange,
}: {
  security: PreviewSecurityRef;
  choice: SecurityChoice | undefined;
  securities: readonly SecurityView[];
  onChange: (choice: SecurityChoice | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const badge = securityBadge(security);
  const suggestion = security.suggestion;
  const editing = choice?.kind === "create" ? choice.security : suggestion;
  const candidates = securities.filter((s) => !s.archived && s.type !== "cash");

  const setSuggestion = (patch: Partial<{ name: string; type: SecurityType; assetClass: AssetClass }>) => {
    if (!editing) return;
    onChange({ kind: "create", security: { ...editing, ...patch } });
  };
  const link = (id: string) => {
    if (id === "") onChange(undefined);
    else onChange({ kind: "existing", securityId: id });
  };

  return (
    <div className="imp-security">
      <div>
        {security.ticker && <strong>{security.ticker}</strong>} {security.name}
        {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
        {choice?.kind === "existing" && <Badge tone="info">linked</Badge>}
        {choice?.kind === "create" && <Badge tone="info">edited</Badge>}
        {!security.isCash && (
          <button type="button" className="link small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? "done" : security.isNew ? "edit or link…" : "change…"}
          </button>
        )}
      </div>
      {open && (
        <div className="imp-security-edit">
          <label className="inline">
            Link to existing
            <select value={choice?.kind === "existing" ? choice.securityId : ""} onChange={(e) => link(e.target.value)} aria-label="Link to an existing security">
              <option value="">{security.isNew ? "— create a new security —" : "— as resolved —"}</option>
              {candidates.map((s) => (
                <option key={s.id} value={s.id}>
                  {securityLabel(s)}
                </option>
              ))}
            </select>
          </label>
          {security.isNew && editing && choice?.kind !== "existing" && (
            <div className="row wrap">
              <input value={editing.name} onChange={(e) => setSuggestion({ name: e.target.value })} aria-label="New security name" placeholder="Name" className="grow" />
              <select value={editing.type} onChange={(e) => setSuggestion({ type: e.target.value as SecurityType })} aria-label="New security type">
                {SECURITY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {securityTypeLabel(t)}
                  </option>
                ))}
              </select>
              <select value={editing.assetClass} onChange={(e) => setSuggestion({ assetClass: e.target.value as AssetClass })} aria-label="New security asset class">
                {ASSET_CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {assetClassLabel(c)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
