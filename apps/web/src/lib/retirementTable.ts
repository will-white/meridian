import { addUp, deflateYearTable, PLANNER_DISCLAIMER, type PlanBucket, type StrategyConfig, type StrategyEvent, type YearRow, type YearTable, type YearTableAccount } from "@meridian/shared";
import { money } from "./format.js";
import { ageLabel, bpExact, BUCKETS, bucketLabel, csvMoney, percentText, priceLevelText, ratioBp } from "./retirementFormat.js";

/**
 * The year-by-year table and its drawer (strategies-outputs-web §5.5 items 6 and 7, seams C37,
 * C42, C52): the column groups, the rows' tones and event chips, the CSV export, and the drawer's
 * two lists. Every amount is a cents string from the stored `YearTable` (nominal) or from the
 * shared bigint `deflateYearTable` (today's dollars); nothing is computed in floats.
 */

export type YearGroupId = "year" | "income" | "spending" | "withdrawals" | "conversions" | "taxes" | "contributions" | "ending" | "rates";

export interface YearTableColumn {
  id: string;
  group: YearGroupId;
  label: string;
  kind: "text" | "money" | "bp" | "level";
  /** Shown only when its group is expanded (the group's first column is its headline). */
  detail: boolean;
  /** The cell's raw value: cents for money, basis points for bp, the stored level, or text. */
  value: (row: YearRow) => string;
}

/** The groups in display order, with the label of their expand control. */
export const YEAR_GROUPS: ReadonlyArray<{ id: YearGroupId; label: string }> = [
  { id: "year", label: "Year" },
  { id: "income", label: "Income" },
  { id: "spending", label: "Spending" },
  { id: "withdrawals", label: "Withdrawals" },
  { id: "conversions", label: "Conversions" },
  { id: "taxes", label: "Taxes" },
  { id: "contributions", label: "Contributions" },
  { id: "ending", label: "Ending balance" },
  { id: "rates", label: "Inflation and return" },
];

const PHASE_LABELS: Record<YearRow["phase"], string> = { accumulation: "Saving", transition: "Transition", retirement: "Retirement" };

const sumCents = (values: readonly string[]) => values.reduce((s, v) => s + BigInt(v), 0n).toString();

/** The people's names for column labels; "Person 1", "Person 2" when none is given. */
function personName(people: readonly string[] | undefined, i: number): string {
  return people?.[i] ?? `Person ${i + 1}`;
}

function bucketsOf(accounts: readonly YearTableAccount[]): PlanBucket[] {
  return BUCKETS.filter((b) => accounts.some((a) => a.bucket === b));
}

/**
 * The columns of a table (§5.5 item 6): year, ages and phase; income (total, then wages, Social
 * Security per person, pensions and annuities, rental, other); spending (funded, then planned, core,
 * healthcare, long-term care, goals, shortfall); withdrawals (total, then by account type, by
 * account, "of which RMD" and the rate); conversions; taxes (the federal total, then ordinary,
 * capital gains, net investment income tax, penalties, and payroll tax, which is not in the total,
 * C37); contributions (total, then employee and employer); ending balance (total, then by account
 * type and by account); the inflation index and the year's return. Buckets with no account are
 * left out. Account names come from the feed and are text, never markup.
 */
export function yearTableColumns(table: Pick<YearTable, "accounts" | "rows">, people?: readonly string[]): YearTableColumn[] {
  const persons = table.rows[0]?.ages.length ?? 0;
  const buckets = bucketsOf(table.accounts);
  const cols: YearTableColumn[] = [];
  const add = (group: YearGroupId, id: string, label: string, kind: YearTableColumn["kind"], detail: boolean, value: (row: YearRow) => string) =>
    cols.push({ id, group, label, kind, detail, value });

  add("year", "year", "Year", "text", false, (r) => String(r.year));
  add("year", "ages", "Ages", "text", false, (r) => ageLabel(r.ages, r.alive));
  add("year", "phase", "Phase", "text", false, (r) => PHASE_LABELS[r.phase]);

  add("income", "income", "Income", "money", false, (r) => r.income.total);
  add("income", "wages", "Wages", "money", true, (r) => r.income.wages);
  for (let p = 0; p < persons; p++) add("income", `ss_${p}`, `Social Security (${personName(people, p)})`, "money", true, (r) => r.income.socialSecurity[p] ?? "0");
  add("income", "pension", "Pensions and annuities", "money", true, (r) => r.income.pensionAnnuity);
  add("income", "rental", "Rental", "money", true, (r) => r.income.rental);
  add("income", "other_income", "Other income", "money", true, (r) => r.income.other);

  add("spending", "funded", "Spending", "money", false, (r) => r.spending.funded);
  add("spending", "planned", "Planned", "money", true, (r) => r.spending.planned);
  add("spending", "core", "Core", "money", true, (r) => r.spending.core);
  add("spending", "healthcare", "Healthcare", "money", true, (r) => r.spending.healthcare);
  add("spending", "ltc", "Long-term care", "money", true, (r) => r.spending.longTermCare);
  add("spending", "goals", "Goals", "money", true, (r) => r.spending.goals);
  add("spending", "shortfall", "Shortfall", "money", true, (r) => r.spending.shortfall);

  add("withdrawals", "withdrawals", "Withdrawals", "money", false, (r) => r.withdrawals.total);
  for (const b of buckets) add("withdrawals", `wd_${b}`, `Withdrawals: ${bucketLabel(b)} accounts`, "money", true, (r) => r.withdrawals.byBucket[b]);
  table.accounts.forEach((a, i) => add("withdrawals", `wd_account_${i}`, `Withdrawals: ${a.name}`, "money", true, (r) => r.withdrawals.byAccount[i] ?? "0"));
  add("withdrawals", "rmd", "of which RMD", "money", true, (r) => r.withdrawals.rmdTotal);
  add("withdrawals", "rate", "Withdrawal rate", "bp", true, (r) => String(r.strategy.withdrawalRateBp));

  add("conversions", "conversions", "Roth conversions", "money", false, (r) => r.conversions);

  add("taxes", "tax", "Federal tax", "money", false, (r) => r.tax.totalFederalCents);
  add("taxes", "ordinary_tax", "Ordinary tax", "money", true, (r) => r.tax.ordinaryTaxCents);
  add("taxes", "gains_tax", "Capital gains tax", "money", true, (r) => r.tax.capitalGainsTaxCents);
  add("taxes", "niit", "Net investment income tax", "money", true, (r) => r.tax.niitCents);
  add("taxes", "penalties", "Penalties", "money", true, (r) => sumCents([r.tax.earlyPenaltyCents, r.tax.hsaPenaltyCents]));
  add("taxes", "payroll", "Payroll tax", "money", true, (r) => r.tax.payrollTaxCents);

  add("contributions", "contributions", "Contributions", "money", false, (r) => sumCents([r.contributions.employee, r.contributions.employer]));
  add("contributions", "employee", "Employee", "money", true, (r) => r.contributions.employee);
  add("contributions", "employer", "Employer", "money", true, (r) => r.contributions.employer);

  add("ending", "ending", "Ending balance", "money", false, (r) => r.ending.total);
  for (const b of buckets) add("ending", `end_${b}`, `Ending: ${bucketLabel(b)} accounts`, "money", true, (r) => r.ending.byBucket[b]);
  table.accounts.forEach((a, i) => add("ending", `end_account_${i}`, `Ending: ${a.name}`, "money", true, (r) => r.ending.byAccount[i] ?? "0"));

  add("rates", "cpi", "Inflation index", "level", false, (r) => r.cpiEnd);
  add("rates", "return", "Return", "bp", false, (r) => String(r.portfolioReturnBp));
  return cols;
}

/** The columns shown: every group's headline, and the detail of the expanded groups. */
export function visibleColumns(columns: readonly YearTableColumn[], expanded: ReadonlySet<YearGroupId> | "all"): YearTableColumn[] {
  return columns.filter((c) => !c.detail || expanded === "all" || expanded.has(c.group));
}

/** A cell as the page shows it: money as "$1,234.56", rates as "6.85%", the index trimmed. */
export function cellText(column: YearTableColumn, row: YearRow): string {
  const v = column.value(row);
  switch (column.kind) {
    case "money":
      return money(v);
    case "bp":
      return bpExact(Number(v));
    case "level":
      return priceLevelText(v);
    default:
      return v;
  }
}

/** An event chip's words (§5.5 item 6), with the strategy's own figures when it is given. */
export function eventLabel(event: StrategyEvent, strategy?: StrategyConfig): string {
  switch (event) {
    case "freeze":
      return "raise skipped";
    case "cut":
      return strategy?.kind === "guardrails" ? `cut ${percentText(strategy.cutBp)}` : "cut";
    case "raise":
      return strategy?.kind === "guardrails" ? `raise ${percentText(strategy.raiseBp)}` : "raise";
    case "band_floor":
      return "at the floor";
    case "band_ceiling":
      return "at the ceiling";
    case "cap":
      return strategy?.kind === "vpw" ? `capped at ${percentText(strategy.maxRateBp)}` : "capped";
    case "essentials":
      return "held at essentials";
    case "topped_up":
      return "topped up to essentials";
    case "rmd_excess":
      return "RMD above the rule";
  }
}

/** A drawdown row whose funded spending is more than a cent short of planned spending plus goals (the shared `pathStory` test), or that failed. */
export function isBelowPlan(row: YearRow): boolean {
  if (row.phase === "accumulation") return false;
  const sp = row.spending;
  return BigInt(sp.shortfall) > 0n || BigInt(sp.funded) + 1n < BigInt(sp.planned) + BigInt(sp.goals);
}

export interface YearRowView {
  year: number;
  cells: string[];
  /** `bad`: the first shortfall year; `bad_tint`: a later one; `warn`: below plan. */
  tone?: "bad" | "bad_tint" | "warn";
  /** "money ran out" on the first shortfall year. */
  flag?: string;
  events: string[];
}

export interface YearTableView {
  columns: YearTableColumn[];
  rows: YearRowView[];
  unit: "today" | "nominal";
  firstShortfallYear?: number;
}

export interface YearTableRequest {
  dollars: "today" | "nominal";
  expanded: ReadonlySet<YearGroupId> | "all";
  people?: readonly string[];
  strategy?: StrategyConfig;
}

/**
 * The table as the page shows it (§5.5 item 6): the stored table in nominal dollars or deflated
 * through the shared bigint `deflateYearTable`; the first shortfall year marked "money ran out" in
 * the bad tone and later ones tinted; below-plan years in the warning tone; events as chips.
 */
export function yearTableView(table: YearTable, request: YearTableRequest): YearTableView {
  const shown = request.dollars === "today" ? deflateYearTable(table) : table;
  const columns = visibleColumns(yearTableColumns(shown, request.people), request.expanded);
  let firstShortfallYear: number | undefined;
  const rows = shown.rows.map((row): YearRowView => {
    const view: YearRowView = { year: row.year, cells: columns.map((c) => cellText(c, row)), events: row.strategy.events.map((e) => eventLabel(e, request.strategy)) };
    if (row.failed) {
      if (firstShortfallYear === undefined) {
        firstShortfallYear = row.year;
        view.tone = "bad";
        view.flag = "money ran out";
      } else view.tone = "bad_tint";
    } else if (isBelowPlan(row)) view.tone = "warn";
    return view;
  });
  const out: YearTableView = { columns, rows, unit: request.dollars };
  if (firstShortfallYear !== undefined) out.firstShortfallYear = firstShortfallYear;
  return out;
}

// ---- CSV (§5.5 item 6, "Export CSV") ----

/** One CSV field (RFC 4180); a text field that a spreadsheet would read as a formula is prefixed with an apostrophe. */
function csvField(text: string, isText: boolean): string {
  const safe = isText && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The expanded table as CSV in the unit shown (§5.5 item 6, UI-4): a header of every group's
 * columns, one line per year, then the unit and the disclaimer as the last line. Money is a plain
 * decimal ("1234.56"), rates are percentages with two decimals, the inflation index the stored
 * level. Account and people names are quoted when needed and never start a formula. Lines end
 * with CRLF.
 */
export function yearTableCsv(table: YearTable, options: { dollars: "today" | "nominal"; people?: readonly string[]; strategy?: StrategyConfig }): string {
  const shown = options.dollars === "today" ? deflateYearTable(table) : table;
  const columns = yearTableColumns(shown, options.people);
  const header = [...columns.map((c) => csvField(c.label, true)), "Events"].join(",");
  const lines = [header];
  for (const row of shown.rows) {
    const cells = columns.map((c) => {
      const v = c.value(row);
      if (c.kind === "money") return csvMoney(v);
      if (c.kind === "bp") return bpExact(Number(v));
      return csvField(v, c.kind === "text");
    });
    cells.push(csvField(row.strategy.events.map((e) => eventLabel(e, options.strategy)).join("; "), true));
    lines.push(cells.join(","));
  }
  lines.push(csvField(options.dollars === "today" ? "Amounts in today's dollars (the price level at the plan start)." : "Amounts in nominal dollars.", true));
  lines.push(csvField(PLANNER_DISCLAIMER, true));
  return `${lines.join("\r\n")}\r\n`;
}

// ---- The year drawer (§5.5 item 7, seams C37, C52) ----

export interface DrawerLine {
  label: string;
  cents: string;
  /** A note under the line: "of which RMD $3,175.65", "85% taxable". */
  detail?: string;
  /** A sub-line of the line above it. */
  indent?: boolean;
}

export interface CashLists {
  /** Income lines and withdrawals by account (RMD marked). */
  sources: DrawerLine[];
  /** Taxes, payroll tax, contributions, spending and surplus saved. */
  uses: DrawerLine[];
  sourcesTotal: string;
  usesTotal: string;
  /** The two lists add up to the same total: every drawdown row (a few cents of rounding absorbed). */
  balanced: boolean;
  /** A difference beyond rounding, shown as the line "Not accounted for"; absent when there is none. */
  unexplainedCents?: string;
  /** "Spending is not modelled before retirement" in an accumulation row (C52). */
  note?: string;
}

export interface TaxLists {
  /** What entered the return. */
  income: DrawerLine[];
  /** AGI, deductions and taxable income with its parts. */
  computation: DrawerLine[];
  /** The tax by component, adding up to the federal total. */
  taxes: DrawerLine[];
  totalCents: string;
  /** Federal tax ÷ AGI, truncated; absent when AGI is not above 0. */
  effectiveRateBp?: number;
  /** The year's top ordinary bracket (the engine's rate). */
  bracketRateBp: number;
  /** Payroll tax, a separate line (C37). */
  payroll: DrawerLine;
  footnote: string;
}

export interface YearDrawer {
  year: number;
  cash: CashLists;
  tax: TaxLists;
}

/** Rounding cells once each leaves at most a few cents between the two sides of the cash identity (the engine's own test allows 5). */
export const DRAWER_ROUNDING_CENTS = 5n;

const nonZero = (lines: DrawerLine[]) => lines.filter((l) => BigInt(l.cents) !== 0n);

/**
 * The drawer of one row, in the row's unit (pass a row of `deflateYearTable` for today's
 * dollars). "Where the money came from and went": income + withdrawals = federal tax (less the tax
 * on income before spending started) + payroll tax + employee contributions + spending + surplus
 * saved + take-home pay before spending started (`YearRow.preStart`). In a drawdown row the two
 * sides are the same total but for each cell's own rounding; that difference (at most
 * `DRAWER_ROUNDING_CENTS`) is absorbed by the largest use (`addUp`), and a larger one is shown as
 * its own line. An accumulation row lists both sides with the note instead (C52). "What you were
 * taxed on" lists the income lines, AGI, deductions and taxable income, then the tax by component.
 */
export function yearDrawer(row: YearRow, accounts: readonly YearTableAccount[], people?: readonly string[]): YearDrawer {
  const inc = row.income;
  const sources: DrawerLine[] = nonZero([
    { label: "Wages", cents: inc.wages },
    ...inc.socialSecurity.map((cents, p) => ({ label: `Social Security (${personName(people, p)})`, cents })),
    { label: "Pensions and annuities", cents: inc.pensionAnnuity },
    { label: "Rental", cents: inc.rental },
    { label: "Other income", cents: inc.other },
  ]);
  accounts.forEach((a, i) => {
    const cents = row.withdrawals.byAccount[i] ?? "0";
    if (BigInt(cents) === 0n) return;
    const rmd = row.withdrawals.rmdByAccount[i] ?? "0";
    const line: DrawerLine = { label: `Withdrawn from ${a.name}`, cents };
    if (BigInt(rmd) > 0n) line.detail = `of which RMD ${money(rmd)}`;
    sources.push(line);
  });
  const sourcesTotal = BigInt(inc.total) + BigInt(row.withdrawals.total);

  const pre = row.preStart;
  const tax = BigInt(row.tax.totalFederalCents) - BigInt(pre?.tax ?? "0");
  const useLines: DrawerLine[] = [
    { label: pre === undefined ? "Federal tax" : "Federal tax (on the months after spending started)", cents: tax.toString() },
    { label: "Payroll tax", cents: row.tax.payrollTaxCents },
    { label: "Employee contributions", cents: row.contributions.employee },
    { label: row.phase === "accumulation" ? "Goals" : "Spending", cents: row.spending.funded },
    { label: "Saved (surplus)", cents: row.surplusSaved },
  ];
  if (pre !== undefined) useLines.push({ label: "Take-home pay before spending started", cents: pre.takeHome });
  let uses = useLines;
  let usesSum = uses.reduce((s, l) => s + BigInt(l.cents), 0n);
  let balanced = false;
  const cash: Partial<CashLists> = {};
  if (row.phase === "accumulation") {
    cash.note = "Spending is not modelled before retirement: income less tax and contributions is not tracked.";
  } else {
    const residual = sourcesTotal - usesSum;
    if (residual !== 0n && residual <= DRAWER_ROUNDING_CENTS && residual >= -DRAWER_ROUNDING_CENTS) {
      const adjusted = addUp(sourcesTotal, uses.map((l) => BigInt(l.cents)));
      uses = uses.map((l, i) => ({ ...l, cents: adjusted[i]!.toString() }));
    } else if (residual !== 0n) {
      // Never hidden: a difference beyond rounding is its own line, so both lists still add up.
      uses = [...uses, { label: "Not accounted for", cents: residual.toString() }];
      cash.unexplainedCents = residual.toString();
    }
    usesSum = sourcesTotal;
    balanced = true;
  }
  uses = uses.filter((l) => BigInt(l.cents) !== 0n);

  const tx = row.tax;
  const benefits = BigInt(sumCents(inc.socialSecurity));
  const taxablePart: DrawerLine = { label: "of which taxable", cents: tx.taxableSocialSecurityCents, indent: true };
  const taxableBp = ratioBp(tx.taxableSocialSecurityCents, benefits);
  if (taxableBp !== undefined) taxablePart.detail = `${percentText(taxableBp)} of benefits`;
  const preTax: DrawerLine = { label: "Pre-tax withdrawals", cents: row.withdrawals.byBucket.pre_tax };
  if (BigInt(row.withdrawals.rmdTotal) > 0n) preTax.detail = `of which RMD ${money(row.withdrawals.rmdTotal)}`;
  const income = [
    { label: "Wages", cents: inc.wages },
    { label: "Pensions and annuities", cents: inc.pensionAnnuity },
    preTax,
    { label: "Roth conversions", cents: row.conversions },
    { label: "Bond interest", cents: row.investment.coupons },
    { label: "Dividends", cents: row.investment.dividends },
    { label: "Realized gains", cents: row.investment.realizedGains },
    { label: "Rental", cents: inc.rental },
    { label: "Other income", cents: inc.other },
  ].filter((l) => BigInt(l.cents) !== 0n);
  if (benefits !== 0n) income.push({ label: "Social Security received", cents: benefits.toString() }, taxablePart);

  const computation: DrawerLine[] = [
    { label: "Adjusted gross income", cents: tx.agiCents },
    { label: "Standard deduction", cents: tx.standardDeductionCents },
  ];
  if (BigInt(tx.seniorDeductionCents) !== 0n) computation.push({ label: "Senior deduction", cents: tx.seniorDeductionCents });
  computation.push({ label: "Taxable income", cents: tx.taxableIncomeCents });
  for (const line of [
    { label: "taxed as ordinary income", cents: tx.ordinaryTaxableCents },
    { label: "gains and qualified dividends at 0%", cents: tx.gainsAt0Cents },
    { label: "at 15%", cents: tx.gainsAt15Cents },
    { label: "at 20%", cents: tx.gainsAt20Cents },
  ]) {
    if (BigInt(line.cents) !== 0n) computation.push({ ...line, indent: true });
  }
  if (BigInt(tx.capitalLossCarryoverCents) !== 0n) computation.push({ label: "Capital loss carried to next year", cents: tx.capitalLossCarryoverCents });

  const taxes: DrawerLine[] = [
    { label: "Ordinary income tax", cents: tx.ordinaryTaxCents },
    { label: "Capital gains tax", cents: tx.capitalGainsTaxCents },
    { label: "Net investment income tax", cents: tx.niitCents },
    { label: "10% additional tax (early withdrawals)", cents: tx.earlyPenaltyCents },
    { label: "20% additional tax (HSA, not for medical costs)", cents: tx.hsaPenaltyCents },
  ];
  const taxLists: TaxLists = {
    income,
    computation,
    taxes,
    totalCents: tx.totalFederalCents,
    bracketRateBp: tx.bracketRateBp,
    payroll: { label: "Payroll tax (Social Security and Medicare on wages; not in the total)", cents: tx.payrollTaxCents },
    footnote: "State tax, IRMAA and ACA subsidies are not modelled in this version.",
  };
  if (BigInt(tx.agiCents) > 0n) taxLists.effectiveRateBp = ratioBp(tx.totalFederalCents, tx.agiCents)!;

  return {
    year: row.year,
    cash: { sources, uses, sourcesTotal: sourcesTotal.toString(), usesTotal: usesSum.toString(), balanced, ...cash },
    tax: taxLists,
  };
}
