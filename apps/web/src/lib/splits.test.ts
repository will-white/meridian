import { describe, expect, it } from "vitest";
import type { TransactionSplitView } from "@meridian/shared";
import { amountInCategory, buildSplitLines, initialSplitDraft, parseSplitAmount, splitRemainderCents, splitRemainderLabel } from "./splits.js";

const line = (categoryId: string | null, amountCents: string, memo: string | null = null): TransactionSplitView => ({ id: `s-${categoryId}-${amountCents}`, categoryId, categoryName: categoryId, amountCents, memo });

describe("amountInCategory", () => {
  it("is the whole amount for a plain row and the matching lines for a split one", () => {
    expect(amountInCategory({ amountCents: "-2500", splits: [] }, "groceries")).toBe(-2500n);
    const split = { amountCents: "-10000", splits: [line("groceries", "-6000"), line("home", "-4000")] };
    expect(amountInCategory(split, "groceries")).toBe(-6000n);
    expect(amountInCategory(split, "home")).toBe(-4000n);
    expect(amountInCategory(split, "fuel")).toBe(0n);
    // Two lines in one category add up.
    expect(amountInCategory({ amountCents: "-10000", splits: [line("home", "-7000"), line("home", "-3000", "paint")] }, "home")).toBe(-10000n);
  });
});

describe("parseSplitAmount", () => {
  it("reads a magnitude in the transaction's direction; a minus runs the other way", () => {
    expect(parseSplitAmount("60", -10000n)).toBe(-6000n);
    expect(parseSplitAmount("$1,234.50", -200000n)).toBe(-123450n);
    expect(parseSplitAmount("-20.00", -10000n)).toBe(2000n); // cash back on a purchase
    expect(parseSplitAmount("60.5", 10000n)).toBe(6050n); // part of a deposit
    expect(parseSplitAmount(".5", -100n)).toBe(-50n);
  });

  it("rejects what is not an amount", () => {
    for (const bad of ["", "abc", "1.234", "1..2", "--5"]) expect(parseSplitAmount(bad, -10000n)).toBeNull();
  });
});

describe("the split editor's lines", () => {
  it("starts from the whole amount on the row's category, or from the existing split", () => {
    expect(initialSplitDraft({ amountCents: "-10000", categoryId: "groceries", splits: [] })).toEqual([
      { categoryId: "groceries", amount: "100.00", memo: "" },
      { categoryId: "", amount: "", memo: "" },
    ]);
    expect(initialSplitDraft({ amountCents: "-10000", categoryId: null, splits: [line("groceries", "-12000"), line("income", "2000", "cash back")] })).toEqual([
      { categoryId: "groceries", amount: "120.00", memo: "" },
      { categoryId: "income", amount: "-20.00", memo: "cash back" },
    ]);
  });

  it("tracks what is left to assign", () => {
    const drafts = [
      { categoryId: "groceries", amount: "60.00", memo: "" },
      { categoryId: "home", amount: "", memo: "" },
    ];
    expect(splitRemainderCents(-10000n, drafts)).toBe(-4000n); // 40.00 of the purchase still unassigned
    expect(splitRemainderCents(-10000n, [drafts[0]!, { categoryId: "home", amount: "40", memo: "" }])).toBe(0n);
    // The status line speaks in the transaction's direction, for purchases and deposits alike.
    expect(splitRemainderLabel(-10000n, drafts)).toEqual({ done: false, text: "40.00 still unassigned" });
    expect(splitRemainderLabel(-10000n, [drafts[0]!, { categoryId: "home", amount: "45", memo: "" }])).toEqual({ done: false, text: "5.00 over the transaction amount" });
    expect(splitRemainderLabel(-10000n, [drafts[0]!, { categoryId: "home", amount: "40", memo: "" }])).toEqual({ done: true, text: "Fully assigned" });
    expect(splitRemainderLabel(250000n, [{ categoryId: "paycheck", amount: "2,000", memo: "" }])).toEqual({ done: false, text: "500.00 still unassigned" });
  });

  it("builds the request when the lines add up to the transaction", () => {
    expect(
      buildSplitLines(-10000n, [
        { categoryId: "groceries", amount: "60.00", memo: "" },
        { categoryId: "home", amount: "40", memo: " shelves " },
        { categoryId: "", amount: "", memo: "" }, // an untouched spare line is ignored
      ]),
    ).toEqual({
      ok: true,
      lines: [
        { categoryId: "groceries", amountCents: "-6000", memo: null },
        { categoryId: "home", amountCents: "-4000", memo: "shelves" },
      ],
    });
    // 120.00 of groceries with 20.00 cash back is a 100.00 purchase.
    expect(
      buildSplitLines(-10000n, [
        { categoryId: "groceries", amount: "120", memo: "" },
        { categoryId: "income", amount: "-20", memo: "" },
      ]),
    ).toMatchObject({ ok: true, lines: [{ amountCents: "-12000" }, { amountCents: "2000" }] });
  });

  it("explains what is wrong instead of sending a bad split", () => {
    const g = (amount: string, categoryId = "groceries") => ({ categoryId, amount, memo: "" });
    expect(buildSplitLines(-10000n, [g("100")])).toEqual({ ok: false, error: "A split needs at least two lines" });
    expect(buildSplitLines(-10000n, [g("60"), g("40", "")])).toEqual({ ok: false, error: "Line 2: pick a category" });
    expect(buildSplitLines(-10000n, [g("60"), g("x", "home")])).toEqual({ ok: false, error: "Line 2: not an amount" });
    expect(buildSplitLines(-10000n, [g("100"), g("0", "home")])).toEqual({ ok: false, error: "Line 2: the amount can't be zero" });
    expect(buildSplitLines(-10000n, [g("60"), g("30", "home")])).toEqual({ ok: false, error: "10.00 is still unassigned" });
    expect(buildSplitLines(-10000n, [g("60"), g("45", "home")])).toEqual({ ok: false, error: "The lines are 5.00 over the transaction amount" });
  });
});
