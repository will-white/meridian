import { Link } from "react-router";
import type { InvestmentFidelity } from "@meridian/shared";
import { Badge } from "../ui.js";
import { fidelityLabel, fidelityTone } from "../../lib/investments.js";

/**
 * The derived fidelity of an investment account (plan decision 7): "Balance
 * only" (neutral), "Positions as of 10/09/26" (info) or "Full history" (ok).
 * A fidelity note ("trade history incomplete: VTI lots cover 20 of 40
 * shares") adds a warn badge carrying the note as its title and, when the
 * account id is known, a link to the account's activity.
 */
export function FidelityBadge({
  fidelity,
  fidelityNote = null,
  positionsDate = null,
  accountId,
}: {
  fidelity: InvestmentFidelity | null;
  fidelityNote?: string | null;
  positionsDate?: string | null;
  accountId?: string;
}) {
  if (fidelity === null) return null;
  return (
    <>
      <Badge tone={fidelityTone(fidelity)}>{fidelityLabel(fidelity, positionsDate)}</Badge>
      {fidelityNote && (
        <span title={fidelityNote}>
          <Badge tone="warn">
            {accountId ? (
              <Link to={`/investments/accounts/${accountId}`} className="inv-badge-link">
                history incomplete
              </Link>
            ) : (
              "history incomplete"
            )}
          </Badge>
        </span>
      )}
    </>
  );
}
