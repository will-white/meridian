import { MutationObserver, QueryClient, type InfiniteData } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountView, HouseholdSettingView, RuleView, TransactionList, TransactionView } from "@meridian/shared";
import * as apiModule from "./api.js";
import { closeQuestion, netWorthCents, parseManualBalance, parseThreshold, reopenNotice, typeChangeQuestion } from "./accountForms.js";
import { accountTypeLabel } from "./format.js";
import { existingAlwaysRule } from "./recategorize.js";
import { recategorizeOptions } from "./registerMutations.js";
import { buildManualTransaction, parseTags, splitTransferQuestion, transactionEditBody, transactionEditForm, transferLabel, withCategory } from "./register.js";
import { buildRule, emptyRuleForm, ruleAccountOptions, ruleCategoryOptions, ruleFormFrom } from "./rulesForm.js";
import { buildSplitLines } from "./splits.js";
import { buildPatch as buildSettingsPatch, fromView as settingsForm } from "../pages/SettingsPage.js";

/**
 * Audit batch a8-ledger-ui (the ledger pages in the web app): the pure helpers the pages use,
 * with hand-worked cases. The rendered pages are tested in
 * apps/web/src/components/ledgerAudit.test.tsx.
 */

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const acct = (over: Partial<AccountView>): Pick<AccountView, "name" | "type" | "connectionId" | "externalId" | "balanceCents" | "closed"> => ({
  name: "Car loan",
  type: "checking",
  connectionId: null,
  externalId: null,
  balanceCents: "1500000",
  closed: false,
  ...over,
});

const txn = (over: Partial<TransactionView> = {}): TransactionView => ({
  id: U(101),
  accountId: U(1),
  accountName: "Checking",
  date: "2026-11-11",
  amountCents: "-123456",
  payeeId: U(201),
  payeeName: "Costco",
  rawDescription: "COSTCO WHSE #0123",
  memo: null,
  categoryId: null,
  categoryName: null,
  categoryLocked: false,
  pending: false,
  isTransfer: false,
  transferPairId: null,
  notes: null,
  tags: [],
  source: "simplefin",
  recurringId: null,
  splits: [],
  transferPartner: null,
  ...over,
});

describe("a8-ledger-ui-01: a type change says what a hand-entered balance becomes", () => {
  it("Checking 15,000 → Loan: owes $15,000.00, the balance becomes -$15,000.00", () => {
    expect(typeChangeQuestion(acct({}), "loan")).toBe("Change Car loan to Loan? It will owe $15,000.00: its balance becomes -$15,000.00, and its earlier balances change the same way.");
  });
  it("Loan owing 400,000 → Asset: worth $400,000.00", () => {
    expect(typeChangeQuestion(acct({ name: "House", type: "loan", balanceCents: "-40000000" }), "asset")).toBe(
      "Change House to Asset? It will be worth $400,000.00: its balance becomes $400,000.00, and its earlier balances change the same way.",
    );
  });
  it("nothing to ask on the same side, for a feed account, a formerly fed one, or no balance", () => {
    expect(typeChangeQuestion(acct({}), "savings")).toBeNull();
    expect(typeChangeQuestion(acct({ type: "credit", balanceCents: "-5000" }), "loan")).toBeNull();
    expect(typeChangeQuestion(acct({ connectionId: U(9), externalId: "X" }), "loan")).toBeNull();
    expect(typeChangeQuestion(acct({ externalId: "X" }), "loan")).toBeNull();
    expect(typeChangeQuestion(acct({ balanceCents: null }), "loan")).toBeNull();
  });
});

describe("a8-ledger-ui-02: closing a feed account is asked, and reopening it says what happens", () => {
  it("a feed account: its transactions stop while closed and are read again on reopen", () => {
    expect(closeQuestion({ name: "Savings", connectionId: U(9) })).toContain("brings in none of its transactions");
    expect(closeQuestion({ name: "Savings", connectionId: U(9) })).toContain("Reopening it reads the transactions it missed");
    expect(reopenNotice({ name: "Savings", connectionId: U(9) })).toContain("The transactions it missed while it was closed are being read");
  });
  it("a manual account: no feed to mention, and nothing to say on reopen", () => {
    expect(closeQuestion({ name: "Cash", connectionId: null })).not.toContain("transactions it missed");
    expect(reopenNotice({ name: "Cash", connectionId: null })).toBeNull();
  });
});

describe("a8-ledger-ui-17: today's net worth leaves closed accounts out, whatever is listed", () => {
  it("2,500 + 10,000 closed − 450 = 2,050.00", () => {
    expect(netWorthCents([acct({ balanceCents: "250000" }), acct({ balanceCents: "1000000", closed: true }), acct({ balanceCents: "-45000" })])).toBe("205000");
  });
});

describe("a8-ledger-ui-14: amounts past the wire's 15 digits are refused in dollars before sending", () => {
  const BIG = "99,999,999,999,999,999.99";
  it("manual balance, threshold, rule bounds and split lines say 'Too large'", () => {
    expect(parseManualBalance(BIG, "checking")).toEqual({ ok: false, error: "Too large (at most 9,999,999,999,999.99)" });
    expect(parseManualBalance("9,999,999,999,999.99", "loan")).toEqual({ ok: true, cents: -999999999999999n });
    expect(parseThreshold(BIG)).toEqual({ ok: false, error: "The threshold is too large (at most 9,999,999,999,999.99)" });
    expect(parseThreshold("1,000")).toEqual({ ok: true, cents: 100000n });
    expect(parseThreshold("1.005").ok).toBe(false);
    expect(buildRule({ ...emptyRuleForm(), payee: { op: "contains", value: "x", caseSensitive: false }, minAmount: `-${BIG}`, setCategory: U(3) })).toEqual({ ok: false, error: "An amount bound is too large (at most 9,999,999,999,999.99)" });
    expect(buildSplitLines(-123456n, [{ categoryId: U(3), amount: BIG, memo: "" }, { categoryId: U(4), amount: "-99,999,999,999,999,998,765.43", memo: "" }])).toEqual({ ok: false, error: "Line 1: too large (at most 9,999,999,999,999.99)" });
  });
});

describe("a8-ledger-ui-14: the household's low-balance threshold on Settings is bounded the same way", () => {
  const view: HouseholdSettingView = {
    planStartMonth: "2026-01",
    zeroBased: false,
    lowBalanceThresholdCents: "50000",
    primaryAccountId: null,
    projectionDefaultDays: 90,
    timezone: "America/Denver",
    benchmarkSecurityId: null,
    investmentIncomeCategoryId: null,
    rebalanceBandBp: 500,
    rebalanceMinTradeCents: "10000",
    updatedAt: "2026-11-13T00:00:00Z",
  };
  it("'Too large' in dollars before sending; '1,000' is 1000.00; blank is 0; '1.005' is refused", () => {
    expect(buildSettingsPatch({ ...settingsForm(view), threshold: "99,999,999,999,999,999.99" }, view)).toEqual({ ok: false, error: "The threshold is too large (at most 9,999,999,999,999.99)" });
    expect(buildSettingsPatch({ ...settingsForm(view), threshold: "1,000" }, view)).toEqual({ ok: true, patch: { lowBalanceThresholdCents: "100000" } });
    expect(buildSettingsPatch({ ...settingsForm(view), threshold: "" }, view)).toEqual({ ok: true, patch: { lowBalanceThresholdCents: "0" } });
    expect(buildSettingsPatch(settingsForm(view), view)).toEqual({ ok: true, patch: {} });
    expect(buildSettingsPatch({ ...settingsForm(view), threshold: "1.005" }, view).ok).toBe(false);
  });
});

describe("a8-ledger-ui-15: account types as people write them", () => {
  it("IRA, 401(k), Roth IRA, HSA, 529 plan, Credit card", () => {
    expect((["ira", "401k", "roth", "hsa", "529", "credit", "checking"] as const).map(accountTypeLabel)).toEqual(["IRA", "401(k)", "Roth IRA", "HSA", "529 plan", "Credit card", "Checking"]);
  });
});

describe("a8-ledger-ui-08: the rule editor shows the category and account the rule has, hidden or closed", () => {
  const cats = [
    { id: U(1), name: "Groceries", hidden: false },
    { id: U(2), name: "Old hidden", hidden: true },
  ];
  const accounts = [
    { id: U(10), name: "Checking", closed: false },
    { id: U(11), name: "Savings", closed: true },
  ];
  it("a rule that sets a hidden category: that category is an option, marked, and the form's value", () => {
    const form = ruleFormFrom({ name: "Old stuff", conditions: { payee: { op: "contains", value: "old" } }, actions: { setCategoryId: U(2) } });
    expect(form.setCategory).toBe(U(2));
    expect(ruleCategoryOptions(cats, form.setCategory)).toEqual([
      { value: U(1), label: "Groceries" },
      { value: U(2), label: "Old hidden (hidden)" },
    ]);
    // Other rules are not offered the hidden one.
    expect(ruleCategoryOptions(cats, "")).toEqual([{ value: U(1), label: "Groceries" }]);
    expect(ruleCategoryOptions(cats, U(99))).toContainEqual({ value: U(99), label: "(deleted category: sets nothing)" });
  });
  it("a rule limited to a closed account: that account is an option, marked", () => {
    const form = ruleFormFrom({ name: "Savings interest", conditions: { accountId: U(11) }, actions: { setCategoryId: U(1) } });
    expect(ruleAccountOptions(accounts, form.accountId)).toEqual([
      { value: U(10), label: "Checking" },
      { value: U(11), label: "Savings (closed)" },
    ]);
    expect(ruleAccountOptions(accounts, "")).toEqual([{ value: U(10), label: "Checking" }]);
  });
});

describe("a8-ledger-ui-04: a row's payee, notes and tags, and a transaction added by hand", () => {
  it("sends only what changed; blank notes clear them; tags are trimmed, de-duplicated and lose a leading #", () => {
    const t = txn({ payeeName: "Costco", notes: "bulk", tags: ["house"] });
    expect(transactionEditBody(t, transactionEditForm(t))).toEqual({ ok: true, body: {} });
    expect(transactionEditBody(t, { payee: " Costco Wholesale ", notes: "", tags: "house, #trip, trip" })).toEqual({ ok: true, body: { payeeName: "Costco Wholesale", notes: null, tags: ["house", "trip"] } });
    expect(transactionEditBody(t, { payee: "", notes: "bulk", tags: "house" })).toEqual({ ok: false, error: "A payee cannot be removed; type the name it should have" });
    expect(transactionEditBody(t, { payee: "Costco", notes: "x".repeat(2001), tags: "house" }).ok).toBe(false);
  });
  it("tags are bounded as the API bounds them: 50 of at most 50 characters", () => {
    expect(parseTags(Array.from({ length: 51 }, (_, i) => `t${i}`).join(","))).toEqual({ ok: false, error: "At most 50 tags" });
    expect(parseTags("x".repeat(51)).ok).toBe(false);
    expect(parseTags(" , ,")).toEqual({ ok: true, tags: [] });
  });
  it("a manual transaction: signed cents by string math, never zero, not after today", () => {
    const form = { accountId: U(1), date: "2026-11-13", amount: "-$1,234.50", payee: " Farmers market ", categoryId: "", notes: "" };
    expect(buildManualTransaction(form, "2026-11-13")).toEqual({ ok: true, body: { accountId: U(1), date: "2026-11-13", amountCents: "-123450", payeeName: "Farmers market" } });
    expect(buildManualTransaction({ ...form, amount: "0.00" }, "2026-11-13")).toEqual({ ok: false, error: "The amount can't be zero" });
    expect(buildManualTransaction({ ...form, amount: "1.005" }, "2026-11-13")).toEqual({ ok: false, error: "Use at most two decimals" });
    expect(buildManualTransaction({ ...form, date: "2026-11-14" }, "2026-11-13").ok).toBe(false);
    expect(buildManualTransaction({ ...form, amount: "99999999999999999" }, "2026-11-13")).toEqual({ ok: false, error: "Too large (at most 9,999,999,999,999.99)" });
  });
});

describe("a8-ledger-ui-10: a split row asks before it becomes a transfer", () => {
  it("says the lines go; a row without a split is not asked", () => {
    const split = txn({ splits: [1, 2, 3].map((n) => ({ id: U(900 + n), categoryId: U(n), categoryName: "x", amountCents: "-1", memo: null })) });
    expect(splitTransferQuestion(split, "mark")).toBe("This transaction is split across 3 lines. A transfer has no split, so the lines are removed and the plan no longer counts it. Mark it as a transfer?");
    expect(splitTransferQuestion(txn(), "pair")).toBeNull();
  });
});

describe("a8-ledger-ui-12: which row a transfer leg is paired with", () => {
  it("to / from the other account and its date; none for a transfer marked alone; null for a non-transfer", () => {
    const partner = { id: U(102), accountId: U(2), accountName: "Savings", date: "2026-11-03" };
    expect(transferLabel(txn({ isTransfer: true, amountCents: "-100000", transferPartner: partner }))).toBe("to Savings · 11/03/26");
    expect(transferLabel(txn({ isTransfer: true, amountCents: "100000", transferPartner: { ...partner, accountName: "Checking" } }))).toBe("from Checking · 11/03/26");
    expect(transferLabel(txn({ isTransfer: true }))).toBe("no other leg in the app");
    expect(transferLabel(txn())).toBeNull();
  });
});

describe("a8-ledger-ui-16 and -05: the category change shows at once, goes back on failure, and prompts only after a save", () => {
  afterEach(() => vi.restoreAllMocks());
  const KEY = ["transactions", { q: "" }];
  const seed = (qc: QueryClient, t: TransactionView) => qc.setQueryData<InfiniteData<TransactionList, unknown>>(KEY, { pages: [{ items: [t], nextCursor: null }], pageParams: [undefined] });
  const shown = (qc: QueryClient) => qc.getQueryData<InfiniteData<TransactionList, unknown>>(KEY)!.pages[0]!.items[0]!;
  const names = (id: string | null) => (id === U(300) ? "Groceries" : null);

  it("while the save is on the way the row shows the pick; on success the prompt is offered", async () => {
    const qc = new QueryClient();
    const t = txn({ categoryId: U(299), categoryName: "Old hidden" });
    seed(qc, t);
    let resolve!: (v: TransactionView) => void;
    vi.spyOn(apiModule, "api").mockImplementation(() => new Promise((r) => (resolve = r as (v: TransactionView) => void)) as never);
    const saved = vi.fn();
    const m = new MutationObserver(qc, recategorizeOptions(qc, names, saved));
    const done = m.mutate({ transaction: t, categoryId: U(300) });
    await vi.waitFor(() => expect(shown(qc)).toMatchObject({ categoryId: U(300), categoryName: "Groceries" }));
    expect(saved).not.toHaveBeenCalled();
    resolve({ ...t, categoryId: U(300), categoryName: "Groceries" });
    await done;
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it("a failed save puts the row back and offers no prompt", async () => {
    const qc = new QueryClient();
    const t = txn({ categoryId: U(299), categoryName: "Old hidden" });
    seed(qc, t);
    vi.spyOn(apiModule, "api").mockRejectedValue(new apiModule.ApiError(0, "Can't reach Meridian.", "network"));
    const saved = vi.fn();
    const m = new MutationObserver(qc, recategorizeOptions(qc, names, saved));
    await m.mutate({ transaction: t, categoryId: U(300) }).catch(() => undefined);
    expect(shown(qc)).toMatchObject({ categoryId: U(299), categoryName: "Old hidden" });
    expect(saved).not.toHaveBeenCalled();
    expect(m.getCurrentResult().error?.message).toBe("Can't reach Meridian.");
  });

  it("withCategory leaves other rows and data it does not hold alone", () => {
    const data = { pages: [{ items: [txn(), txn({ id: U(102) })], nextCursor: null }], pageParams: [undefined] };
    const out = withCategory(data, U(102), U(300), "Groceries")!;
    expect(out.pages[0]!.items.map((r) => r.categoryId)).toEqual([null, U(300)]);
    expect(withCategory(data, U(999), U(300), "Groceries")).toBe(data);
  });
});

describe("a8-ledger-ui-09: the rule 'always do this' would duplicate is found as the rules engine matches", () => {
  const rule = (over: Partial<RuleView> = {}): RuleView => ({
    id: U(500),
    name: "Cafe Rio → Dining",
    position: 2,
    enabled: true,
    conditions: { payee: { op: "equals", value: "cafe rio" } },
    actions: { setCategoryId: U(301) },
    createdAt: "2026-11-01T00:00:00Z",
    ...over,
  });
  const target = { payeeName: "Café Rio", categoryId: U(301) };
  it("case and Latin accents folded, as the engine folds them; a case-sensitive rule compares exactly", () => {
    expect(existingAlwaysRule([rule()], target)?.id).toBe(U(500));
    expect(existingAlwaysRule([rule({ conditions: { payee: { op: "equals", value: "cafe rio", caseSensitive: true } } })], target)).toBeUndefined();
    expect(existingAlwaysRule([rule({ conditions: { payee: { op: "equals", value: "Café Rio", caseSensitive: true } } })], target)?.id).toBe(U(500));
  });
  it("not a rule that contains the name, adds a condition, sets another category, is off, or marks the row a transfer", () => {
    for (const other of [
      rule({ conditions: { payee: { op: "contains", value: "cafe rio" } } }),
      rule({ conditions: { payee: { op: "equals", value: "cafe rio" }, accountId: U(1) } }),
      rule({ actions: { setCategoryId: U(302) } }),
      rule({ enabled: false }),
      rule({ actions: { setCategoryId: U(301), markTransfer: true } }),
    ]) {
      expect(existingAlwaysRule([other], target)).toBeUndefined();
    }
    expect(existingAlwaysRule(undefined, target)).toBeUndefined();
  });
});
