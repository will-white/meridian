import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { StrategyConfigInput } from "@meridian/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { runsInOwnFile } from "../testIsolation.js";
import { buildSimInput } from "../testing/simInput.js";
import { decideSpending } from "./decide.js";
import { createSpendingOutcome, settleSpending } from "./outcome.js";
import { prepareStrategies } from "./prepare.js";
import { level, testView, type TestView } from "./testKit.js";
import { STRATEGY_STATE_LENGTH, type SpendDecision, createSpendDecision } from "./types.js";

// ST-17 (strategies-outputs-web §7.1; decision 38): purity and the hook rules. Equal state and view
// give equal decisions; the hot-path sources call no banned Math function and allocate nothing;
// 10,000 calls leave the heap unchanged within noise.

const KINDS: StrategyConfigInput[] = [
  { kind: "constant_dollar" },
  { kind: "fixed_percentage" },
  { kind: "guardrails" },
  { kind: "vpw" },
  { kind: "floor_ceiling" },
];

function household(strategy: StrategyConfigInput) {
  return prepareStrategies(
    buildSimInput({
      people: [{ birthYear: 1960 }, { birthYear: 1963 }],
      spending: {
        baseAnnualCents: "9000000",
        essentialAnnualCents: "5000000",
        survivorBp: 7000,
        phases: [{ fromYear: 2040, multiplierBp: 9000 }],
        goals: [{ id: "roof", name: "roof", year: 2030, amountCents: "2000000", dollars: "today" }],
        healthcare: [
          { personId: "p1", preMedicareAnnualCents: "0", preMedicareFrom: "2027-01", medicareFrom: "2027-01", medicareAnnualCents: "500000", realGrowthBp: 100, inBase: false },
          { personId: "p2", preMedicareAnnualCents: "900000", preMedicareFrom: "2027-01", medicareFrom: "2028-06", medicareAnnualCents: "500000", realGrowthBp: 100, inBase: true },
        ],
        longTermCare: [{ personId: "p2", reserveCents: "10000000", lastYears: 2 }],
      },
      strategy,
    }),
  );
}

/** Years of a path with ups and downs, a death in plan year 12 and outside income. */
function viewAt(tb: ReturnType<typeof household>, t: number): TestView {
  const r = [0.12, -0.18, 0.07, -0.05, 0.22, 0.03][t % 6]!;
  return testView(tb, {
    t,
    cpi: level(1.027, t),
    age: [67 + t, 64 + t],
    alive: [1, t <= 12 ? 1 : 0],
    yearsToDeath: [25 - t, 12 - t],
    portfolioStart: 1_500_000 * (1 + 0.4 * r) - 20_000 * t,
    guaranteedIncome: 30_000 * level(1.027, t),
    otherIncome: 1_000,
    prevPortfolioReturn: t > 0 ? r : Number.NaN,
    prevInflation: t > 0 ? 0.027 : Number.NaN,
    stockShare: 0.55,
  });
}

function sameDecision(a: SpendDecision, b: SpendDecision): void {
  for (const key of Object.keys(a) as Array<keyof SpendDecision>) expect(Object.is(a[key], b[key])).toBe(true);
}

describe("ST-17 purity and rules", () => {
  it("ST-17 equal state and view give equal decisions and equal next states, for all five kinds", () => {
    for (const kind of KINDS) {
      const tb = household(kind);
      const s1 = new Float64Array(STRATEGY_STATE_LENGTH);
      const s2 = new Float64Array(STRATEGY_STATE_LENGTH);
      const d1 = createSpendDecision();
      const d2 = createSpendDecision();
      for (let t = 0; t < 20; t++) {
        const view = viewAt(tb, t);
        const s3 = Float64Array.from(s1);
        decideSpending(view, s1, d1);
        decideSpending(view, s2, d2);
        sameDecision(d1, d2);
        expect(Array.from(s1)).toEqual(Array.from(s2));
        // A fresh record gives the same decision as the reused one: nothing carries over in `out`.
        const fresh = createSpendDecision();
        decideSpending(view, s3, fresh);
        sameDecision(fresh, d1);
      }
    }
  });

  it("ST-17 the hot-path sources call no banned Math function and allocate nothing outside their create functions", () => {
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
    const insideThrow = (node: ts.Node): boolean => {
      for (let p: ts.Node | undefined = node; p !== undefined; p = p.parent) if (ts.isThrowStatement(p)) return true;
      return false;
    };
    const files = ["decide.ts", "planned.ts", "guardrails.ts", "floorCeiling.ts", "vpw.ts", "outcome.ts", "../trades.ts"];
    const findings: string[] = [];
    for (const file of files) {
      const path = fileURLToPath(new URL(file, import.meta.url));
      const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node, fn: string | undefined): void => {
        const where = `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Math" && BANNED.has(node.name.text)) {
          findings.push(`${where} Math.${node.name.text}`);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken) findings.push(`${where} **`);
        // Inside a hot function only an error being thrown may allocate.
        if (fn !== undefined && !fn.startsWith("create") && ALLOCATING.has(node.kind) && !insideThrow(node)) {
          findings.push(`${where} ${ts.SyntaxKind[node.kind]} in ${fn}`);
        }
        const name = ts.isFunctionDeclaration(node) && node.name ? node.name.text : fn;
        ts.forEachChild(node, (child) => visit(child, name));
      };
      visit(sf, undefined);
    }
    expect(findings).toEqual([]);
  });

  it("ST-17 no allocation in 10,000 calls (heap unchanged within noise)", ({ skip }) => {
    if (!runsInOwnFile(import.meta.url, expect.getState().testPath)) skip(); // a heap check means something only in its own file (testIsolation.ts)
    const tbs = KINDS.map(household);
    const views = tbs.map((tb) => Array.from({ length: 20 }, (_, t) => viewAt(tb, t)));
    const states = tbs.map(() => new Float64Array(STRATEGY_STATE_LENGTH));
    const out = createSpendDecision();
    const outcome = createSpendingOutcome();
    const run = (calls: number) => {
      for (let n = 0; n < calls; n++) {
        const k = n % 5;
        const t = (n >> 3) % 20;
        if (t === 0) states[k]!.fill(0);
        decideSpending(views[k]![t]!, states[k]!, out);
        settleSpending(out, 1, true, 1_000 - (n % 7) * 500, 10_000, outcome);
      }
    };
    run(200_000); // warm-up: let the optimizing compiler settle
    const before = process.memoryUsage().heapUsed;
    run(10_000);
    const after = process.memoryUsage().heapUsed;
    // One boxed double per call would be 160 KB; one small object 320 KB or more.
    expect(after - before).toBeLessThan(64 * 1024);
  });
});
