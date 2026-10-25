import { formatCents, formatFixed8, impliedPrice, mulToCents, parseFixed8, parseLooseDecimal, ppmToPercent, roundDivHalfAway } from "@meridian/shared";
import type {
  AccountInvestmentView,
  AssetClass,
  CreateInvestmentTxnBody,
  CreateSecurityBody,
  HoldingSnapshotView,
  InvestmentTxnType,
  InvestmentTxnView,
  LastReconciliationView,
  LotPickInput,
  LotView,
  ManualPositionInput,
  ManualPositionsBody,
  PriceSource,
  SecurityType,
  SecurityView,
  TransferDirection,
  UpdateSecurityBody,
} from "@meridian/shared";
import { money, shortDate } from "./format.js";
import type { BadgeTone } from "./investments.js";

/**
 * Pure helpers behind the Securities page, the account investments page,
 * `TradeForm`, `LotPickDialog` and `PositionsEditor`: form state from the
 * views, validation that mirrors the API's rules, request bodies, and the
 * sentences the pages show. Cents are bigint until formatted; quantities and
 * prices are Fixed8 strings; the only floats are display conversions.
 */

// ---- Securities ----

const SECURITY_TYPE_LABELS: Record<SecurityType, string> = { stock: "Stock", etf: "ETF", fund: "Fund", bond: "Bond", cash: "Cash", cd: "CD", other: "Other" };

export const SECURITY_TYPES: readonly SecurityType[] = ["stock", "etf", "fund", "bond", "cd", "other"];

export function securityTypeLabel(type: SecurityType): string {
  return SECURITY_TYPE_LABELS[type];
}

export interface SecurityForm {
  ticker: string;
  name: string;
  type: SecurityType;
  assetClass: AssetClass;
  /** A percent string: "0.03" for 300 ppm; blank for none. */
  expenseRatio: string;
  priceMode: PriceSource;
  providerSymbol: string;
  alwaysPrice: boolean;
  notes: string;
}

export function securityForm(s: SecurityView): SecurityForm {
  return {
    ticker: s.ticker ?? "",
    name: s.name,
    type: s.type,
    assetClass: s.assetClass,
    expenseRatio: s.expenseRatioPpm === null ? "" : ppmToPercent(s.expenseRatioPpm),
    priceMode: s.priceMode,
    providerSymbol: s.providerSymbol ?? "",
    alwaysPrice: s.alwaysPrice,
    notes: s.notes ?? "",
  };
}

/** The empty create form; a `?q=` ticker from the Reconcile page's "create security" link prefills the ticker. */
export function newSecurityForm(ticker = ""): SecurityForm {
  return { ticker: ticker.trim().toUpperCase(), name: "", type: "stock", assetClass: "us_stock", expenseRatio: "", priceMode: "provider", providerSymbol: "", alwaysPrice: false, notes: "" };
}

export type ExpenseRatioParse = { ok: true; value: string | null } | { ok: false; error: string };

/** "0.03", "0.03%" or " .035 " → the API's PercentString ("0.03", "0.035"); blank → null; up to four decimals below 100 %. */
export function parseExpenseRatio(raw: string): ExpenseRatioParse {
  const s = raw.replace(/[%\s]/g, "");
  if (s === "") return { ok: true, value: null };
  const m = /^(\d{0,2})(?:\.(\d{1,4}))?$/.exec(s);
  if (!m || (m[1] === "" && m[2] === undefined)) return { ok: false, error: "The expense ratio is a percent with at most four decimals (0.03 for 0.03 %)" };
  const whole = m[1] === "" ? "0" : String(Number(m[1]));
  return { ok: true, value: m[2] !== undefined ? `${whole}.${m[2]}` : whole };
}

/** An expense ratio for display: 326 ppm → "0.0326%". */
export function expenseRatioText(ppm: number | null): string {
  return ppm === null ? "—" : `${ppmToPercent(ppm)}%`;
}

export type SecurityPatchParse = { ok: true; patch: UpdateSecurityBody } | { ok: false; error: string };

/**
 * The PATCH body for the edit form: only the fields that changed; the ticker
 * and symbol trimmed (blank → null); provider mode needs a ticker or a
 * provider symbol (the server's `ticker_required`); cash securities cannot
 * change type or class.
 */
export function buildSecurityPatch(form: SecurityForm, s: SecurityView): SecurityPatchParse {
  const patch: UpdateSecurityBody = {};
  const name = form.name.trim();
  if (name === "") return { ok: false, error: "A name is required" };
  if (name !== s.name) patch.name = name;
  const ticker = form.ticker.trim().toUpperCase() || null;
  if (ticker !== null && ticker.length > 20) return { ok: false, error: "A ticker has at most 20 characters" };
  if (ticker !== s.ticker) patch.ticker = ticker;
  if (s.type === "cash" && (form.type !== "cash" || form.assetClass !== "cash")) return { ok: false, error: "The cash security keeps its type and class" };
  if (form.type !== s.type) patch.type = form.type;
  if (form.assetClass !== s.assetClass) patch.assetClass = form.assetClass;
  const ratio = parseExpenseRatio(form.expenseRatio);
  if (!ratio.ok) return ratio;
  const currentRatio = s.expenseRatioPpm === null ? null : ppmToPercent(s.expenseRatioPpm);
  if (ratio.value !== currentRatio) patch.expenseRatioPercent = ratio.value;
  const providerSymbol = form.providerSymbol.trim() || null;
  if (providerSymbol !== null && providerSymbol.length > 32) return { ok: false, error: "A provider symbol has at most 32 characters" };
  if (providerSymbol !== s.providerSymbol) patch.providerSymbol = providerSymbol;
  if (form.priceMode !== s.priceMode) patch.priceMode = form.priceMode;
  if (form.priceMode === "provider" && ticker === null && providerSymbol === null) return { ok: false, error: "Provider pricing needs a ticker or a provider symbol" };
  if (form.alwaysPrice !== s.alwaysPrice) patch.alwaysPrice = form.alwaysPrice;
  const notes = form.notes.trim() || null;
  if (notes !== s.notes) patch.notes = notes;
  return { ok: true, patch };
}

export type CreateSecurityParse = { ok: true; body: CreateSecurityBody } | { ok: false; error: string };

/** The POST body for a new security (the owner typed it, so it never needs review). */
export function buildCreateSecurity(form: SecurityForm): CreateSecurityParse {
  const name = form.name.trim();
  if (name === "") return { ok: false, error: "A name is required" };
  if (form.type === "cash") return { ok: false, error: "The cash security is reserved; cash positions resolve to it by themselves" };
  const ratio = parseExpenseRatio(form.expenseRatio);
  if (!ratio.ok) return ratio;
  const ticker = form.ticker.trim().toUpperCase() || null;
  const providerSymbol = form.providerSymbol.trim() || null;
  if (form.priceMode === "provider" && ticker === null && providerSymbol === null) return { ok: false, error: "Provider pricing needs a ticker or a provider symbol" };
  const body: CreateSecurityBody = { name, type: form.type, assetClass: form.assetClass, ticker, priceMode: form.priceMode, providerSymbol, alwaysPrice: form.alwaysPrice };
  if (ratio.value !== null) body.expenseRatioPercent = ratio.value;
  const notes = form.notes.trim();
  if (notes !== "") body.notes = notes;
  return { ok: true, body };
}

/** Why a security cannot be deleted (the button shows it as its title); null when it can. */
export function securityDeleteReason(s: Pick<SecurityView, "type" | "held" | "heldInAccounts">): string | null {
  if (s.type === "cash") return "the cash security is reserved";
  if (s.held) return `held in ${s.heldInAccounts} account${s.heldInAccounts === 1 ? "" : "s"}; merge it into another security or archive it instead`;
  return null;
}

/** "VTI · Vanguard Total Stock Market ETF" for selects and lists. */
export function securityLabel(s: Pick<SecurityView, "ticker" | "name">): string {
  return s.ticker ? `${s.ticker} · ${s.name}` : s.name;
}

export type SecurityChip = "all" | "review" | "held";

/** The default filter chip: Needs review when any security needs it, else All. */
export function defaultSecurityChip(securities: ReadonlyArray<Pick<SecurityView, "needsReview">>): SecurityChip {
  return securities.some((s) => s.needsReview) ? "review" : "all";
}

/** The securities a chip shows (archived rows only under All, and only when asked for). */
export function filterSecurities<T extends Pick<SecurityView, "needsReview" | "held" | "archived">>(securities: readonly T[], chip: SecurityChip): T[] {
  switch (chip) {
    case "review":
      return securities.filter((s) => s.needsReview && !s.archived);
    case "held":
      return securities.filter((s) => s.held && !s.archived);
    case "all":
      return [...securities];
  }
}

// ---- The account's investment block ----

/** "positions match the latest statement" / "lots differ from the latest statement" / null when nothing was checked. */
export function positionsMatchText(inv: Pick<AccountInvestmentView, "positionsMatch" | "fidelityNote" | "lastSnapshotDate">): { text: string; tone: BadgeTone } | null {
  if (inv.positionsMatch === null) return null;
  const date = inv.lastSnapshotDate ? ` (${shortDate(inv.lastSnapshotDate)})` : "";
  if (inv.positionsMatch) return { text: `positions match the latest statement${date}`, tone: "ok" };
  return { text: inv.fidelityNote ?? `the lots differ from the latest statement${date}`, tone: "warn" };
}

/** "Reconciled 10/13/26 · exact" / "· to the dollar" / "· off by $1.00" / "recorded, not accepted"; null when never checked. */
export function lastReconciliationText(lr: LastReconciliationView | null): { text: string; tone: BadgeTone } | null {
  if (lr === null) return null;
  const lead = `${lr.accepted ? "Reconciled" : "Checked"} ${shortDate(lr.statementDate)}`;
  if (lr.diffCents === null) return { text: `${lead} · no app value that day`, tone: "neutral" };
  const diff = BigInt(lr.diffCents);
  if (diff === 0n) return { text: `${lead} · exact`, tone: "ok" };
  if (lr.reconciled) return { text: `${lead} · to the dollar`, tone: "ok" };
  return { text: `${lead} · off by ${money((diff < 0n ? -diff : diff).toString())}`, tone: "warn" };
}

export type AccountTab = "positions" | "trades";

export function accountTabFromParam(raw: string | null): AccountTab {
  return raw === "trades" ? "trades" : "positions";
}

// ---- Trades ----

export const TRADE_TYPES: ReadonlyArray<readonly [InvestmentTxnType, string]> = [
  ["buy", "Buy"],
  ["sell", "Sell"],
  ["reinvest", "Reinvest"],
  ["dividend", "Dividend"],
  ["interest", "Interest"],
  ["fee", "Fee"],
  ["split", "Split"],
  ["transfer", "Transfer"],
];

export function tradeTypeLabel(type: InvestmentTxnType): string {
  return TRADE_TYPES.find(([t]) => t === type)?.[1] ?? type;
}

export function tradeTypeTone(type: InvestmentTxnType): BadgeTone {
  switch (type) {
    case "buy":
    case "reinvest":
      return "info";
    case "sell":
      return "warn";
    case "dividend":
    case "interest":
      return "ok";
    case "fee":
      return "bad";
    case "split":
    case "transfer":
      return "neutral";
  }
}

export interface TradeFormState {
  type: InvestmentTxnType;
  date: string;
  /** "" = none (cash for a transfer; account-level for dividend/interest/fee). */
  securityId: string;
  quantity: string;
  price: string;
  fee: string;
  /** Dollars; blank = the rounding rule's default for buy/sell/reinvest. */
  amount: string;
  splitNum: string;
  splitDen: string;
  direction: TransferDirection;
  counterpartyAccountId: string;
  costBasis: string;
  acquiredDate: string;
  memo: string;
}

export function emptyTradeForm(today: string, type: InvestmentTxnType = "buy"): TradeFormState {
  return { type, date: today, securityId: "", quantity: "", price: "", fee: "", amount: "", splitNum: "", splitDen: "", direction: "in", counterpartyAccountId: "", costBasis: "", acquiredDate: "", memo: "" };
}

/** Dollars ("1,234.56", "$12", "(12.50)") to cents; null when not an amount with at most two decimals. */
export function dollarsToCentsSigned(raw: string): bigint | null {
  const v = parseLooseDecimal(raw);
  if (v === undefined || v % 1_000_000n !== 0n) return null;
  return v / 1_000_000n;
}

/** A quantity or price input to a canonical Fixed8 string; null when unreadable or not positive. */
export function positiveFixed8(raw: string): string | null {
  const v = parseLooseDecimal(raw);
  return v === undefined || v <= 0n ? null : formatFixed8(v);
}

/**
 * The default signed cash effect (imports design §3.10, R1 rounding): buy
 * −(quantity × price + fee), sell quantity × price − fee, reinvest −quantity ×
 * price; null while the inputs are incomplete.
 */
export function defaultTradeAmountCents(type: InvestmentTxnType, quantity: string, price: string, fee: string): bigint | null {
  const q = parseLooseDecimal(quantity);
  const p = parseLooseDecimal(price);
  if (q === undefined || p === undefined || q <= 0n || p < 0n) return null;
  const feeCents = fee.trim() === "" ? 0n : dollarsToCentsSigned(fee);
  if (feeCents === null || feeCents < 0n) return null;
  const gross = mulToCents(q, p);
  switch (type) {
    case "buy":
      return -(gross + feeCents);
    case "sell":
      return gross - feeCents;
    case "reinvest":
      return -gross;
    default:
      return null;
  }
}

export type TradeParse = { ok: true; body: CreateInvestmentTxnBody } | { ok: false; error: string };

/**
 * The form to `CreateInvestmentTxnBody`, type by type: buy/sell/reinvest need
 * a security, a positive quantity and a price (the amount is sent only when
 * typed, else the server applies the same rule); dividend/interest/fee need
 * a signed amount (income positive, a fee negative); a split needs a ratio;
 * a transfer needs a direction, a quantity for shares or an amount for cash,
 * and basis and acquired date only for outside transfers in.
 */
export function parseTradeForm(f: TradeFormState, accountId: string, today: string): TradeParse {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return { ok: false, error: "Enter the trade date" };
  if (f.date > today) return { ok: false, error: "The trade date cannot be in the future" };
  const memo = f.memo.trim();
  const base = { accountId, date: f.date, today, ...(memo !== "" ? { memo } : {}) };
  switch (f.type) {
    case "buy":
    case "sell":
    case "reinvest": {
      if (f.securityId === "") return { ok: false, error: "Pick the security" };
      const quantity = positiveFixed8(f.quantity);
      if (quantity === null) return { ok: false, error: "Enter a positive share quantity" };
      const priceV = parseLooseDecimal(f.price);
      if (priceV === undefined || priceV < 0n) return { ok: false, error: "Enter the price per share" };
      const price = formatFixed8(priceV);
      const feeCents = f.fee.trim() === "" ? null : dollarsToCentsSigned(f.fee);
      if (f.fee.trim() !== "" && (feeCents === null || feeCents < 0n)) return { ok: false, error: "The fee is a non-negative dollar amount" };
      const amountCents = f.amount.trim() === "" ? null : dollarsToCentsSigned(f.amount);
      if (f.amount.trim() !== "" && amountCents === null) return { ok: false, error: "The amount is a dollar amount" };
      if (amountCents !== null && f.type === "sell" && amountCents < 0n) return { ok: false, error: "A sale's amount is the cash received (positive)" };
      if (amountCents !== null && f.type !== "sell" && amountCents > 0n) return { ok: false, error: "A purchase's amount is the cash paid (negative)" };
      const common = { ...base, securityId: f.securityId, quantity, price, ...(feeCents !== null ? { feeCents: feeCents.toString() } : {}), ...(amountCents !== null ? { amountCents: amountCents.toString() } : {}) };
      if (f.type === "sell") return { ok: true, body: { ...common, type: "sell" } };
      return { ok: true, body: { ...common, type: f.type } };
    }
    case "dividend":
    case "interest":
    case "fee": {
      const amountCents = dollarsToCentsSigned(f.amount);
      if (amountCents === null || amountCents === 0n) return { ok: false, error: "Enter the amount" };
      const signed = f.type === "fee" ? -(amountCents < 0n ? -amountCents : amountCents) : amountCents;
      if (f.type !== "fee" && signed < 0n) return { ok: false, error: "Income is a positive amount (a reversal can be edited after saving)" };
      if (f.type === "dividend" && f.securityId === "") return { ok: false, error: "A dividend names its security (use Interest for account-level cash interest)" };
      const body = { ...base, amountCents: signed.toString(), ...(f.securityId !== "" ? { securityId: f.securityId } : { securityId: null }) };
      if (f.type === "fee") return { ok: true, body: { ...body, type: "fee" } };
      return { ok: true, body: { ...body, type: f.type } };
    }
    case "split": {
      if (f.securityId === "") return { ok: false, error: "Pick the security" };
      const num = Number(f.splitNum);
      const den = Number(f.splitDen);
      if (!Number.isInteger(num) || !Number.isInteger(den) || num < 1 || den < 1) return { ok: false, error: "Enter the split ratio as whole numbers (new : old, e.g. 2 : 1)" };
      return { ok: true, body: { ...base, type: "split", securityId: f.securityId, splitNum: num, splitDen: den } };
    }
    case "transfer": {
      const counterparty = f.counterpartyAccountId !== "" ? { counterpartyAccountId: f.counterpartyAccountId } : {};
      if (f.counterpartyAccountId === accountId) return { ok: false, error: "The other account must be a different account" };
      if (f.securityId === "") {
        const amountCents = dollarsToCentsSigned(f.amount);
        if (amountCents === null || amountCents <= 0n) return { ok: false, error: "Enter the cash amount transferred (positive; the direction gives the sign)" };
        return { ok: true, body: { ...base, type: "transfer", direction: f.direction, securityId: null, amountCents: amountCents.toString(), ...counterparty } };
      }
      const quantity = positiveFixed8(f.quantity);
      if (quantity === null) return { ok: false, error: "Enter the share quantity transferred" };
      const body: Extract<CreateInvestmentTxnBody, { type: "transfer" }> = { ...base, type: "transfer", direction: f.direction, securityId: f.securityId, quantity, ...counterparty };
      if (f.direction === "in" && f.counterpartyAccountId === "") {
        if (f.costBasis.trim() !== "") {
          const basis = dollarsToCentsSigned(f.costBasis);
          if (basis === null || basis < 0n) return { ok: false, error: "The cost basis is a non-negative dollar amount" };
          body.costBasisCents = basis.toString();
        } else body.costBasisCents = null;
        if (f.acquiredDate !== "") {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(f.acquiredDate) || f.acquiredDate > f.date) return { ok: false, error: "The acquired date is on or before the transfer date" };
          body.acquiredDate = f.acquiredDate;
        } else body.acquiredDate = null;
      }
      return { ok: true, body };
    }
  }
}

/** The signed amount of a row with its tone (income and sales positive, purchases and fees negative). */
export function txnAmountTone(t: Pick<InvestmentTxnView, "amountCents">): "pos" | "neg" | "" {
  const v = BigInt(t.amountCents);
  return v > 0n ? "pos" : v < 0n ? "neg" : "";
}

/** "manual" / "imported" / "imported · edited by hand"; the SimpleFIN and OFX sources are reserved. */
export function txnSourceText(t: Pick<InvestmentTxnView, "source" | "userEdited">): string {
  if (t.source === "manual") return "manual";
  const base = t.source === "csv" ? "imported" : t.source;
  return t.userEdited ? `${base} · edited by hand` : base;
}

/** "Specific: 3 lots" / "FIFO (no picks)" for a sell or a transfer out of shares. */
export function lotPickLabel(t: Pick<InvestmentTxnView, "type" | "transferDirection" | "securityId" | "lotPicks">): string | null {
  if (!isDisposal(t)) return null;
  return t.lotPicks.length > 0 ? `Specific: ${t.lotPicks.length} lot${t.lotPicks.length === 1 ? "" : "s"}` : "FIFO (no picks)";
}

/** A sale or a transfer out of a security: the rows that may carry lot picks. */
export function isDisposal(t: Pick<InvestmentTxnView, "type" | "transferDirection" | "securityId">): boolean {
  return t.securityId !== null && (t.type === "sell" || (t.type === "transfer" && t.transferDirection === "out"));
}

/** A one-line description of a row: "Buy 10 × 123.45", "Dividend", "Split 2:1", "Transfer in (cash)". */
export function txnSummary(t: Pick<InvestmentTxnView, "type" | "quantity" | "price" | "splitNum" | "splitDen" | "transferDirection" | "securityId">, formatQty: (q: string) => string): string {
  switch (t.type) {
    case "buy":
    case "sell":
    case "reinvest":
      return `${tradeTypeLabel(t.type)}${t.quantity ? ` ${formatQty(t.quantity)}` : ""}${t.price ? ` × ${formatQty(t.price)}` : ""}`;
    case "split":
      return `Split ${t.splitNum ?? "?"}:${t.splitDen ?? "?"}`;
    case "transfer":
      return `Transfer ${t.transferDirection ?? ""}${t.securityId === null ? " (cash)" : t.quantity ? ` ${formatQty(t.quantity)} sh` : ""}`;
    default:
      return tradeTypeLabel(t.type);
  }
}

// ---- Lot picks ----

export type LotPicksParse = { ok: true; picks: LotPickInput[]; sumQuantity: string } | { ok: false; error: string };

/**
 * The dialog's quantities to `SetLotPicksBody.picks`, mirroring the route
 * (seams C7): blank rows are dropped, each pick is positive and at most the
 * lot's original quantity (the lots service reports today's remaining
 * quantity, which later sales have already consumed, so the original is the
 * client's upper bound and the route's dry rebuild is the authority for
 * `pick_exceeds_lot`), and Σ picks ≤ the sale's quantity (`picks_exceed_sale`;
 * FIFO covers the remainder). An empty set clears the picks.
 */
export function parseLotPicks(drafts: Readonly<Record<string, string>>, lots: ReadonlyArray<Pick<LotView, "id" | "originalQuantity">>, saleQuantity: string): LotPicksParse {
  const picks: LotPickInput[] = [];
  let sum = 0n;
  for (const lot of lots) {
    const raw = (drafts[lot.id] ?? "").trim();
    if (raw === "") continue;
    const v = parseLooseDecimal(raw);
    if (v === undefined || v <= 0n) return { ok: false, error: "Each pick is a positive share quantity" };
    if (v > parseFixed8(lot.originalQuantity)) return { ok: false, error: `A pick exceeds the lot's quantity (${formatFixed8(parseFixed8(lot.originalQuantity))})` };
    picks.push({ lotId: lot.id, quantity: formatFixed8(v) });
    sum += v;
  }
  if (sum > parseFixed8(saleQuantity)) return { ok: false, error: `The picks (${formatFixed8(sum)}) exceed the sale's ${formatFixed8(parseFixed8(saleQuantity))} shares` };
  return { ok: true, picks, sumQuantity: formatFixed8(sum) };
}

/** The security's lots acquired on or before the sale date and not closed before it, oldest first (the engine's FIFO order). */
export function pickableLots(lots: readonly LotView[], securityId: string, saleDate: string): LotView[] {
  return lots
    .filter((l) => l.securityId === securityId && l.acquiredDate <= saleDate && (l.closedDate === null || l.closedDate >= saleDate))
    .sort((a, b) => (a.acquiredDate < b.acquiredDate ? -1 : a.acquiredDate > b.acquiredDate ? 1 : a.ordinal - b.ordinal));
}

/** The gain a pick would realize: quantity × sale price − the lot's original basis per share × quantity (plan decision 2's rounding); null when the basis is unknown. */
export function estimatedLotGain(lot: Pick<LotView, "originalQuantity" | "originalCostBasisCents" | "basisKnown">, salePrice: string | null, quantity: string): bigint | null {
  if (!lot.basisKnown || lot.originalCostBasisCents === null || salePrice === null) return null;
  const q = parseLooseDecimal(quantity);
  if (q === undefined || q <= 0n) return null;
  const original = parseFixed8(lot.originalQuantity);
  if (original <= 0n) return null;
  const proceeds = mulToCents(q, parseFixed8(salePrice));
  const basis = roundDivHalfAway(BigInt(lot.originalCostBasisCents) * q, original);
  return proceeds - basis;
}

// ---- Positions editor ----

export interface PositionRowForm {
  key: string;
  /** An existing security, or null while a new one is described below. */
  securityId: string | null;
  /** The new security when `securityId` is null. */
  create: { ticker: string; name: string; type: SecurityType; assetClass: AssetClass } | null;
  label: string;
  quantity: string;
  price: string;
  /** Dollars. */
  value: string;
  /** Dollars; optional. */
  cost: string;
}

let positionSeq = 0;

export function newPositionKey(): string {
  positionSeq += 1;
  return `p${positionSeq}`;
}

export function emptyPositionRow(): PositionRowForm {
  return { key: newPositionKey(), securityId: null, create: null, label: "", quantity: "", price: "", value: "", cost: "" };
}

/** The editor's rows from a snapshot (the security resolved by id, the values as typed amounts). */
export function positionRowsFromSnapshot(snapshot: Pick<HoldingSnapshotView, "rows">): PositionRowForm[] {
  return snapshot.rows.map((r) => ({
    key: newPositionKey(),
    securityId: r.securityId,
    create: null,
    label: r.ticker ? `${r.ticker} · ${r.name}` : r.name,
    quantity: r.quantity ?? "",
    price: r.price ?? "",
    value: formatCents(BigInt(r.valueCents)),
    cost: r.reportedCostBasisCents === null ? "" : formatCents(BigInt(r.reportedCostBasisCents)),
  }));
}

/** quantity × price as dollars (R1) when both are readable; the other field's placeholder. */
export function derivedValueText(quantity: string, price: string): string | null {
  const q = parseLooseDecimal(quantity);
  const p = parseLooseDecimal(price);
  if (q === undefined || p === undefined || q <= 0n || p < 0n) return null;
  return formatCents(mulToCents(q, p));
}

/** value ÷ quantity as a price (R3) when both are readable. */
export function derivedPriceText(valueDollars: string, quantity: string): string | null {
  const cents = dollarsToCentsSigned(valueDollars);
  const q = parseLooseDecimal(quantity);
  if (cents === null || q === undefined || q <= 0n) return null;
  return formatFixed8(impliedPrice(cents, q));
}

export type PositionsParse = { ok: true; positions: ManualPositionInput[]; sumCents: bigint } | { ok: false; errors: Record<string, string> };

/**
 * The rows to `ManualPositionsBody.positions`, mirroring the contract: each
 * row names a security (existing or new with a name), gives a price or a
 * value, and a price needs a quantity; a value-only row without a quantity is
 * a dollar-only position; the cost is optional. Rows without any figure are dropped.
 */
export function parsePositionRows(rows: readonly PositionRowForm[]): PositionsParse {
  const errors: Record<string, string> = {};
  const positions: ManualPositionInput[] = [];
  let sum = 0n;
  for (const row of rows) {
    // A row without any figure is dropped, even when a security is named (a prefilled row the owner emptied).
    const blank = row.quantity.trim() === "" && row.price.trim() === "" && row.value.trim() === "";
    if (blank) continue;
    let security: ManualPositionInput["security"];
    if (row.securityId !== null) security = { kind: "existing", securityId: row.securityId };
    else if (row.create !== null && row.create.name.trim() !== "") {
      security = { kind: "create", security: { ticker: row.create.ticker.trim().toUpperCase() || null, cusip: null, isin: null, name: row.create.name.trim(), type: row.create.type, assetClass: row.create.assetClass } };
    } else {
      errors[row.key] = "pick a security or describe a new one";
      continue;
    }
    const quantity = row.quantity.trim() === "" ? null : parseLooseDecimal(row.quantity);
    if (quantity === undefined || (quantity !== null && quantity <= 0n)) {
      errors[row.key] = "the quantity is a positive number of shares (blank for a value-only position)";
      continue;
    }
    const price = row.price.trim() === "" ? null : parseLooseDecimal(row.price);
    if (price === undefined || (price !== null && price < 0n)) {
      errors[row.key] = "the price is not a number";
      continue;
    }
    const value = row.value.trim() === "" ? null : dollarsToCentsSigned(row.value);
    if (value === undefined || (row.value.trim() !== "" && value === null)) {
      errors[row.key] = "the value is not a dollar amount";
      continue;
    }
    if (price === null && value === null) {
      errors[row.key] = "give a price or a value";
      continue;
    }
    if (price !== null && quantity === null) {
      errors[row.key] = "a price needs a quantity (or give the value instead)";
      continue;
    }
    const cost = row.cost.trim() === "" ? null : dollarsToCentsSigned(row.cost);
    if (row.cost.trim() !== "" && cost === null) {
      errors[row.key] = "the cost basis is not a dollar amount";
      continue;
    }
    const position: ManualPositionInput = { security };
    if (quantity !== null) position.quantity = formatFixed8(quantity);
    if (price !== null) position.price = formatFixed8(price);
    if (value !== null) position.valueCents = value.toString();
    if (cost !== null) position.costBasisCents = cost.toString();
    positions.push(position);
    sum += value ?? mulToCents(quantity!, price!);
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, positions, sumCents: sum };
}

export type PositionsBodyParse = { ok: true; body: ManualPositionsBody; sumCents: bigint } | { ok: false; error: string; rowErrors: Record<string, string> };

/** The whole PUT body: the rows, the as-of date (≤ today) and the optional statement total (seams C40). */
export function buildPositionsBody(rows: readonly PositionRowForm[], asOfDate: string, statementTotal: string, today: string): PositionsBodyParse {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return { ok: false, error: "Enter the statement date", rowErrors: {} };
  if (asOfDate > today) return { ok: false, error: "The statement date cannot be in the future", rowErrors: {} };
  const parsed = parsePositionRows(rows);
  if (!parsed.ok) return { ok: false, error: "Some rows need attention", rowErrors: parsed.errors };
  if (parsed.positions.length === 0) return { ok: false, error: "Enter at least one position", rowErrors: {} };
  const body: ManualPositionsBody = { asOfDate, positions: parsed.positions, today };
  if (statementTotal.trim() !== "") {
    const total = dollarsToCentsSigned(statementTotal);
    if (total === null) return { ok: false, error: "The statement total is not a dollar amount", rowErrors: {} };
    body.statementTotalCents = total.toString();
  }
  return { ok: true, body, sumCents: parsed.sumCents };
}

/** "Σ positions $3,337.75 · statement total $3,350.09 · $12.34 of cash the positions omit" (or null without a total). */
export function statementTotalNote(sumCents: bigint, statementTotal: string): string | null {
  if (statementTotal.trim() === "") return null;
  const total = dollarsToCentsSigned(statementTotal);
  if (total === null) return null;
  const diff = total - sumCents;
  const tail = diff === 0n ? "equal" : diff > 0n ? `${money(diff.toString())} of cash the positions omit` : `positions exceed the statement by ${money((-diff).toString())}`;
  return `Σ positions ${money(sumCents.toString())} · statement total ${money(total.toString())} · ${tail}`;
}
