import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { runsInOwnFile } from "../testIsolation.js";
import { CASH_TOL } from "../constants.js";
import { ASSESS_MAX_CALLS, type AssessFn, type Assessment } from "../hooks.js";
import { TREATMENT } from "../prepare.js";
import { decideSpending } from "../strategies/decide.js";
import { type SpendDecision, createSpendDecision } from "../strategies/types.js";
import { type WithdrawalView, createEngineHooks, createWithdrawalPlanner, planWithdrawalsWith } from "./plan.js";

// Build step 19: the contract of `planWithdrawals` (strategies-outputs-web §3.6; engine-and-returns
// §3.9; seams F4) on a hand-made `assess`: net = base + Σ w[a] × (1 − rate[a]), a flat tax per
// account. The real tax function is in withdrawals.real.test.ts and withdrawals.sweep.test.ts.

const { cash: CASH, pre_tax: PRE_TAX, taxable: TAXABLE } = TREATMENT;

function view(treatment: number[], available: number[], o: { rmd?: number[]; f?: number } = {}): WithdrawalView {
  return {
    accountCount: treatment.length,
    treatment,
    owner: treatment.map((tr) => (tr === CASH || tr === TAXABLE ? -1 : 0)),
    available,
    rmd: o.rmd ?? treatment.map(() => 0),
    preTaxPenaltyShare: treatment.map(() => 0),
    rothFree: [0, 0],
    alive: [1, 1],
    cpi: 1,
    yearFraction: o.f ?? 1,
    strategies: { cashReserve: 0 },
  };
}

/** A flat-tax `assess` and its call count: net = base + Σ w[a] × (1 − rate[a]). */
function flatAssess(base: number, rate: number[]): { assess: AssessFn; calls: () => number; net: (w: ArrayLike<number>) => number } {
  let calls = 0;
  const net = (w: ArrayLike<number>) => {
    let x = base;
    for (let a = 0; a < rate.length; a++) x += w[a]! * (1 - rate[a]!);
    return x;
  };
  return {
    assess: (w: Float64Array, out: Assessment) => {
      calls += 1;
      out.net = net(w);
    },
    calls: () => calls,
    net,
  };
}

function target(): SpendDecision {
  return createSpendDecision();
}

function grossYear(gross: number, lump = 0): SpendDecision {
  const d = createSpendDecision();
  d.gross = gross;
  d.lump = lump;
  return d;
}

function plan(v: WithdrawalView, d: SpendDecision, a: ReturnType<typeof flatAssess>, limit = ASSESS_MAX_CALLS) {
  const p = createWithdrawalPlanner(0, limit);
  const w = new Float64Array(v.accountCount);
  planWithdrawalsWith(p, v, d, a.assess, w);
  return { w: Array.from(w), p, calls: a.calls(), net: a.net(w) };
}

describe("§3.6 target and accumulation years", () => {
  // Cash 10,000 (tier 1, nothing taxable), then pre-tax 200,000 (tier 4) taxed at 20%.
  const v = view([CASH, PRE_TAX], [10000, 200000]);

  it("§3.6 net(0) ≥ −TOL: nothing is withdrawn, one call (income and RMDs cover the year; the loop saves the rest)", () => {
    for (const base of [0, 1234.56, -CASH_TOL]) {
      const r = plan(v, target(), flatAssess(base, [0, 0.2]));
      expect(r.w).toEqual([0, 0]);
      expect(r.calls).toBe(1);
    }
  });

  it("§3.6 a gross-up: cash 10,000, then pre-tax x with 0.8x = 30,000: 37,500; |net| ≤ TOL in at most 4 calls", () => {
    // net(x) = x − 0.2 × max(0, x − 10,000) − 40,000 = 0 at x = 47,500.
    const r = plan(v, target(), flatAssess(-40000, [0, 0.2]));
    expect(r.w[0]).toBeCloseTo(10000, 6);
    expect(r.w[1]).toBeCloseTo(37500, 2);
    expect(Math.abs(r.net)).toBeLessThanOrEqual(CASH_TOL);
    expect(r.calls).toBeLessThanOrEqual(4);
    expect(r.p.converged).toBe(1);
  });

  it("§3.6 net(total) ≤ TOL: everything is taken in two calls (short, or exactly enough)", () => {
    // Everything: 10,000 + 0.8 × 200,000 = 170,000 against a need of 200,000 (short) and 170,000 (exact).
    for (const need of [200000, 170000]) {
      const r = plan(v, target(), flatAssess(-need, [0, 0.2]));
      expect(r.w).toEqual([10000, 200000]);
      expect(r.calls).toBe(2);
    }
  });

  it("§3.6 nothing available: one call and no withdrawal (the second call would repeat the first)", () => {
    const r = plan(view([CASH, PRE_TAX], [0, 0]), target(), flatAssess(-5000, [0, 0.2]));
    expect(r.w).toEqual([0, 0]);
    expect(r.calls).toBe(1);
  });
});

describe("§3.6 gross years", () => {
  // Taxable 100,000 (tier 3, untaxed here) and pre-tax 300,000 at 20%, with an RMD of 10,000 already taken.
  const v = view([TAXABLE, PRE_TAX], [100000, 300000], { rmd: [0, 10000] });

  it("§3.6 the rule's withdrawal pays the floor: w = fill(gross × f + lump − Σ rmd), one call", () => {
    // wd = 30,000 + 5,000 − 10,000 = 25,000 from the taxable account.
    const r = plan(v, grossYear(30000, 5000), flatAssess(-1000, [0, 0.2]));
    expect(r.w).toEqual([25000, 0]);
    expect(r.calls).toBe(1);
    expect(r.p.released).toBe(25000);
    // A first year of 3 months: wd = 30,000 × 0.25 + 5,000 − 10,000 = 2,500.
    const part = plan(view([TAXABLE, PRE_TAX], [100000, 300000], { rmd: [0, 10000], f: 0.25 }), grossYear(30000, 5000), flatAssess(0, [0, 0.2]));
    expect(part.w).toEqual([2500, 0]);
  });

  it("§3.6 RMDs above the rule: wd = 0, nothing more is withdrawn", () => {
    const r = plan(v, grossYear(8000), flatAssess(500, [0, 0.2]));
    expect(r.w).toEqual([0, 0]);
    expect(r.calls).toBe(1);
  });

  it("§3.6 topped up to the floor: the gross-up started from wd", () => {
    // wd = 20,000; net(wd) = 20,000 − 140,000 < 0; the taxable 100,000 then pre-tax y with
    // 100,000 + 0.8y = 140,000: y = 50,000; total 150,000.
    const r = plan(v, grossYear(30000), flatAssess(-140000, [0, 0.2]));
    expect(r.w[0]).toBeCloseTo(100000, 6);
    expect(r.w[1]).toBeCloseTo(50000, 2);
    expect(Math.abs(r.net)).toBeLessThanOrEqual(CASH_TOL);
    expect(r.calls).toBeLessThanOrEqual(5);
  });

  it("§3.6 wd = total: everything, one call, even when the floor is not paid", () => {
    const r = plan(v, grossYear(1e7), flatAssess(-1e6, [0, 0.2]));
    expect(r.w).toEqual([100000, 300000]);
    expect(r.calls).toBe(1);
  });

  it("§3.6 net(total) ≤ TOL after the rule's withdrawal: everything, two calls", () => {
    const r = plan(v, grossYear(30000), flatAssess(-400000, [0, 0.2]));
    expect(r.w).toEqual([100000, 300000]);
    expect(r.calls).toBe(2);
  });
});

describe("F4 and the call limit", () => {
  it("F4 a planner cut off at its limit returns the smallest amount found with net ≥ 0, never more calls", () => {
    const v = view([PRE_TAX], [100000]);
    for (const limit of [2, 3]) {
      const r = plan(v, target(), flatAssess(-40000, [0.2]), limit);
      expect(r.calls).toBe(limit);
      expect(r.net).toBeGreaterThanOrEqual(0);
      expect(r.p.converged).toBe(0);
    }
  });

  it("F4 every year stays within ASSESS_MAX_CALLS, on 2,000 seeded flat-tax years", () => {
    let s = 0x51ab;
    const rnd = () => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return s / 4294967296;
    };
    for (let n = 0; n < 2000; n++) {
      const A = 1 + Math.floor(rnd() * 5);
      const kinds = [CASH, TAXABLE, PRE_TAX];
      const v = view(
        Array.from({ length: A }, () => kinds[Math.floor(rnd() * 3)]!),
        Array.from({ length: A }, () => Math.floor(rnd() * 300000)),
      );
      const rate = Array.from({ length: A }, () => rnd() * 0.6);
      const d = rnd() < 0.5 ? target() : grossYear(rnd() * 100000, rnd() < 0.2 ? 20000 : 0);
      const r = plan(v, d, flatAssess(-rnd() * 400000, rate));
      expect(r.calls).toBeLessThanOrEqual(ASSESS_MAX_CALLS);
      const total = Array.from(v.available).reduce((x, y) => x + y, 0);
      const taken = r.w.reduce((x, y) => x + y, 0);
      // |net| ≤ TOL, or nothing beyond the rule's withdrawal with net ≥ 0, or everything drawn.
      const ok = Math.abs(r.net) <= CASH_TOL || (r.net >= 0 && taken <= r.p.released + 1e-6) || (r.net >= 0 && taken === 0) || Math.abs(taken - total) <= 1e-6;
      expect(ok, `year ${n}: net ${r.net}, taken ${taken} of ${total}`).toBe(true);
    }
  });

  it("the planner's arrays follow the account count of each run on the thread", () => {
    const p = createWithdrawalPlanner();
    const one = flatAssess(-100, [0]);
    planWithdrawalsWith(p, view([CASH], [500]), target(), one.assess, new Float64Array(1));
    expect(p.tiers.accountCount).toBe(1);
    const two = flatAssess(-100, [0, 0]);
    const w = new Float64Array(2);
    planWithdrawalsWith(p, view([CASH, CASH], [500, 1500]), target(), two.assess, w);
    expect(p.tiers.accountCount).toBe(2);
    expect(Array.from(w)).toEqual([25, 75]);
  });
});

describe("decision 38 hook rules", () => {
  it("createEngineHooks gives the strategies' decideSpending and a planWithdrawals of its own", () => {
    const a = createEngineHooks();
    const b = createEngineHooks();
    expect(a.decideSpending).toBe(decideSpending);
    expect(a.planWithdrawals).not.toBe(b.planWithdrawals);
  });

  it("the sources call no banned Math function and allocate nothing outside their create functions", () => {
    const BANNED = new Set(["exp", "log", "log2", "log10", "log1p", "expm1", "pow", "sin", "cos", "tan", "atan", "atan2", "cbrt", "hypot", "random"]);
    const ALLOCATING = new Set([
      ts.SyntaxKind.NewExpression,
      ts.SyntaxKind.ArrayLiteralExpression,
      ts.SyntaxKind.ObjectLiteralExpression,
      ts.SyntaxKind.ArrowFunction,
      ts.SyntaxKind.FunctionExpression,
      ts.SyntaxKind.TemplateExpression,
      ts.SyntaxKind.SpreadElement,
    ]);
    const findings: string[] = [];
    for (const file of ["tiers.ts", "solve.ts", "plan.ts"]) {
      const path = fileURLToPath(new URL(file, import.meta.url));
      const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node, fn: string | undefined): void => {
        const where = `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Math" && BANNED.has(node.name.text)) {
          findings.push(`${where} Math.${node.name.text}`);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken) findings.push(`${where} **`);
        if (fn !== undefined && !fn.startsWith("create") && ALLOCATING.has(node.kind)) findings.push(`${where} ${ts.SyntaxKind[node.kind]} in ${fn}`);
        const name = ts.isFunctionDeclaration(node) && node.name ? node.name.text : fn;
        ts.forEachChild(node, (child) => visit(child, name));
      };
      visit(sf, undefined);
    }
    expect(findings).toEqual([]);
  });

  it("no allocation in 10,000 planned years (heap unchanged within noise)", ({ skip }) => {
    if (!runsInOwnFile(import.meta.url)) skip(); // a heap check means something only in its own file (testIsolation.ts)
    // Cash, taxable and two pre-tax accounts; a flat 20% on pre-tax; target and gross years.
    const v = view([CASH, TAXABLE, PRE_TAX, PRE_TAX], [5000, 20000, 300000, 100000], { rmd: [0, 0, 4000, 0] });
    const rate = new Float64Array([0, 0.05, 0.2, 0.2]);
    let base = 0;
    const assess: AssessFn = (w, out) => {
      let x = base;
      for (let a = 0; a < 4; a++) x += w[a]! * (1 - rate[a]!);
      out.net = x;
    };
    const p = createWithdrawalPlanner(4);
    const w = new Float64Array(4);
    const tgt = target();
    const gross = grossYear(30000);
    const run = (years: number) => {
      for (let n = 0; n < years; n++) {
        base = -1000 - (n % 97) * 1500;
        planWithdrawalsWith(p, v, (n & 1) === 0 ? tgt : gross, assess, w);
      }
    };
    run(100_000);
    const before = process.memoryUsage().heapUsed;
    run(10_000);
    const after = process.memoryUsage().heapUsed;
    // One boxed double per year would be 160 KB.
    expect(after - before).toBeLessThan(64 * 1024);
  });
});
