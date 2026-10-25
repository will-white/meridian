import type { HoldingPriceSource, PriceStatus, ValueSource } from "@meridian/shared";
import { Badge } from "../ui.js";
import { priceStatusText, priceStatusTone } from "../../lib/investments.js";

/**
 * One chip for a price's freshness, shared by the Portfolio, Holdings and
 * Prices pages: "as of 10/13/26 · feed", "stale 3 trading days (10/08/26)",
 * "implied as of 09/30/26", "manual · 10/01/26", "carried from statement".
 * A `valueSource` of `unpriced` is spelled out even when the status says more.
 */
export function PriceStatusChip({
  priceStatus,
  priceDate,
  tradingDaysBehind = null,
  priceSource = null,
  valueSource,
}: {
  priceStatus: PriceStatus;
  priceDate: string | null;
  tradingDaysBehind?: number | null;
  priceSource?: HoldingPriceSource | null;
  valueSource?: ValueSource;
}) {
  if (valueSource === "unpriced") return <Badge tone="bad">unpriced</Badge>;
  return <Badge tone={priceStatusTone(priceStatus)}>{priceStatusText({ priceStatus, priceDate, tradingDaysBehind, priceSource })}</Badge>;
}
