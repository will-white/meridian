import { describe, expect, it } from "vitest";
import { TREATMENT } from "../prepare.js";
import { createSpendDecision } from "../strategies/types.js";
import { TIER, TIER_COUNT, type TierView, buildTiers, createWithdrawalTiers, fill } from "./tiers.js";

// Build step 19: the default order's tiers and `fill` (strategies-outputs-web §2.4, §3.5,
// decisions 18 to 20; seams C33, C34, C35). Every figure below is the design's or is derived by
// hand in the comment beside it.

const { cash: CASH, taxable: TAXABLE, pre_tax: PRE_TAX, roth: ROTH, hsa: HSA } = TREATMENT;

interface ViewOptions {
  treatment: number[];
  owner: number[];
  available: number[];
  share?: number[];
  rothFree?: number[];
  alive?: number[];
  cpi?: number;
  f?: number;
  reserve?: number;
}

function view(o: ViewOptions): TierView {
  return {
    accountCount: o.treatment.length,
    treatment: o.treatment,
    owner: o.owner,
    available: o.available,
    preTaxPenaltyShare: o.share ?? o.treatment.map(() => 0),
    rothFree: o.rothFree ?? [0, 0],
    alive: o.alive ?? [1, 1],
    cpi: o.cpi ?? 1,
    yearFraction: o.f ?? 1,
    strategies: { cashReserve: o.reserve ?? 0 },
  };
}

function tiersOf(v: TierView, healthcare = 0) {
  const decision = createSpendDecision();
  decision.healthcare = healthcare;
  const tiers = createWithdrawalTiers(v.accountCount);
  buildTiers(v, decision, tiers);
  return tiers;
}

const capOf = (tiers: ReturnType<typeof tiersOf>, k: number, a: number) => tiers.accountCap[k * tiers.accountCount + a]!;

function take(tiers: ReturnType<typeof tiersOf>, x: number): number[] {
  const w = new Float64Array(tiers.accountCount);
  fill(tiers, x, w);
  return Array.from(w);
}

const closeAll = (xs: number[], ys: number[], digits = 6) => {
  expect(xs.length).toBe(ys.length);
  xs.forEach((x, i) => expect(x, `index ${i}`).toBeCloseTo(ys[i]!, digits));
};

describe("§3.5 the default order", () => {
  // Single, 57 (early for pre-tax and Roth: share 1), cash 10,000 with a reserve of 5,000, a
  // taxable account of 20,000, pre-tax 300,000, Roth 80,000 of which 30,000 free.
  const v = view({
    treatment: [CASH, TAXABLE, PRE_TAX, ROTH],
    owner: [-1, -1, 0, 0],
    available: [10000, 20000, 300000, 80000],
    share: [0, 0, 1, 0],
    rothFree: [30000, 0],
    reserve: 5000,
  });
  const tiers = tiersOf(v);

  it("§3.5 caps: cash above the reserve 5,000; taxable 20,000; free Roth 30,000; the reserve 5,000; early pre-tax 300,000; the rest of the Roth 50,000", () => {
    const caps = Array.from(tiers.cap);
    // Tier:  1     2  3      4  5      6     7       8      9
    closeAll(caps, [5000, 0, 20000, 0, 30000, 5000, 300000, 50000, 0]);
    expect(tiers.total).toBe(410000);
    expect(capOf(tiers, TIER.CASH, 0)).toBe(5000);
    expect(capOf(tiers, TIER.CASH_RESERVE, 0)).toBe(5000);
    expect(capOf(tiers, TIER.PRE_TAX_EARLY, 2)).toBe(300000);
    expect(capOf(tiers, TIER.ROTH_FREE, 3)).toBe(30000);
    expect(capOf(tiers, TIER.ROTH_REST, 3)).toBe(50000);
  });

  it("§3.5 90,000 through the order: cash 5,000 + 5,000 (tiers 1 and 6), taxable 20,000, Roth 30,000, pre-tax 30,000 (tier 7)", () => {
    // 5,000 + 20,000 + 30,000 + 5,000 = 60,000 whole tiers; the last 30,000 from tier 7.
    closeAll(take(tiers, 90000), [10000, 20000, 30000, 30000]);
    // Inside tier 1 only cash is taken; inside tier 5 the taxable account is already empty.
    closeAll(take(tiers, 4000), [4000, 0, 0, 0]);
    closeAll(take(tiers, 40000), [5000, 20000, 0, 15000]);
  });
});

describe("WD-18 pro rata inside a tier", () => {
  it("WD-18 two pre-tax accounts of 600,000 and 200,000 in tier 4, 40,000 from the tier: 30,000 and 10,000", () => {
    // 40,000 × 600,000 / 800,000 = 30,000 and 40,000 × 200,000 / 800,000 = 10,000.
    const tiers = tiersOf(view({ treatment: [PRE_TAX, PRE_TAX], owner: [0, 1], available: [600000, 200000] }));
    expect(tiers.cap[TIER.PRE_TAX]).toBe(800000);
    closeAll(take(tiers, 40000), [30000, 10000]);
  });
});

describe("C33 a pre-tax account's tier follows its penalty share", () => {
  it("C33 share 0 (past 59½, or a 401(k) after separating at 55) is tier 4; a whole or partial early year is tier 7", () => {
    // An IRA past 59½ (0), a 401(k) whose owner separated at 55 (0, though under 59½), an IRA in
    // the year of 59½ with 3 of 12 months before it (0.25), an IRA of an owner under 59½ (1).
    const tiers = tiersOf(
      view({ treatment: [PRE_TAX, PRE_TAX, PRE_TAX, PRE_TAX], owner: [0, 1, 0, 1], available: [100000, 50000, 40000, 10000], share: [0, 0, 0.25, 1] }),
    );
    closeAll([capOf(tiers, TIER.PRE_TAX, 0), capOf(tiers, TIER.PRE_TAX, 1), capOf(tiers, TIER.PRE_TAX, 2), capOf(tiers, TIER.PRE_TAX, 3)], [100000, 50000, 0, 0]);
    closeAll([capOf(tiers, TIER.PRE_TAX_EARLY, 2), capOf(tiers, TIER.PRE_TAX_EARLY, 3)], [40000, 10000]);
    // 160,000: tier 4 whole (150,000), then 10,000 of tier 7 pro rata 40,000 : 10,000.
    closeAll(take(tiers, 160000), [100000, 50000, 8000, 2000]);
  });
});

describe("C34 the free part of each person's Roth", () => {
  it("C34 tier 5 is min(the person's Roth, rothFree), split over the person's Roth accounts by available; the rest is tier 8", () => {
    // Person 0: Roth 30,000 and 10,000, 20,000 free: tier 5 15,000 and 5,000, tier 8 the same.
    // Person 1: Roth 50,000 with 60,000 free (never more than the balance): tier 5 50,000.
    const tiers = tiersOf(view({ treatment: [ROTH, ROTH, ROTH], owner: [0, 0, 1], available: [30000, 10000, 50000], rothFree: [20000, 60000] }));
    closeAll([capOf(tiers, TIER.ROTH_FREE, 0), capOf(tiers, TIER.ROTH_FREE, 1), capOf(tiers, TIER.ROTH_FREE, 2)], [15000, 5000, 50000]);
    closeAll([capOf(tiers, TIER.ROTH_REST, 0), capOf(tiers, TIER.ROTH_REST, 1), capOf(tiers, TIER.ROTH_REST, 2)], [15000, 5000, 0]);
    expect(tiers.cap[TIER.ROTH_FREE]).toBe(70000);
    expect(tiers.cap[TIER.ROTH_REST]).toBe(20000);
  });

  it("C34 nothing free (earnings before the five-year clock, or an early owner without basis): the whole Roth is tier 8", () => {
    const tiers = tiersOf(view({ treatment: [ROTH], owner: [1], available: [25000], rothFree: [0, 0] }));
    expect(tiers.cap[TIER.ROTH_FREE]).toBe(0);
    expect(tiers.cap[TIER.ROTH_REST]).toBe(25000);
  });
});

describe("C35 the HSA tiers", () => {
  it("C35 tier 2 is min(Σ HSA of living owners, healthcare × f), split over the HSAs by available; the rest is tier 9", () => {
    // Healthcare 10,000 a year in a first year of six months: 5,000 qualified. HSAs of 6,000 and
    // 2,000: tier 2 3,750 and 1,250 (5,000 × 6/8, × 2/8); tier 9 2,250 and 750.
    const tiers = tiersOf(view({ treatment: [HSA, HSA], owner: [0, 1], available: [6000, 2000], f: 0.5 }), 10000);
    closeAll([capOf(tiers, TIER.HSA_MEDICAL, 0), capOf(tiers, TIER.HSA_MEDICAL, 1)], [3750, 1250]);
    closeAll([capOf(tiers, TIER.HSA_REST, 0), capOf(tiers, TIER.HSA_REST, 1)], [2250, 750]);
  });

  it("C35 no healthcare: every HSA dollar is tier 9; an HSA whose owner is not alive is tier 9 only", () => {
    const none = tiersOf(view({ treatment: [HSA], owner: [0], available: [5000] }), 0);
    expect(none.cap[TIER.HSA_MEDICAL]).toBe(0);
    expect(none.cap[TIER.HSA_REST]).toBe(5000);
    const widowed = tiersOf(view({ treatment: [HSA, HSA], owner: [0, 1], available: [6000, 2000], alive: [1, 0] }), 10000);
    closeAll([capOf(widowed, TIER.HSA_MEDICAL, 0), capOf(widowed, TIER.HSA_MEDICAL, 1)], [6000, 0]);
    closeAll([capOf(widowed, TIER.HSA_REST, 0), capOf(widowed, TIER.HSA_REST, 1)], [0, 2000]);
  });
});

describe("decision 20 the cash reserve", () => {
  it("decision 20 the reserve is today's dollars × cpi; tier 1 and tier 6 split each cash account in the same proportion", () => {
    // Reserve 10,000 × 1.1 = 11,000 of cash 20,000 + 10,000: tier 1 19,000, as 20,000 × 19/30 =
    // 12,666.67 and 10,000 × 19/30 = 6,333.33; tier 6 7,333.33 and 3,666.67.
    const tiers = tiersOf(view({ treatment: [CASH, CASH], owner: [-1, 0], available: [20000, 10000], cpi: 1.1, reserve: 10000 }));
    expect(tiers.cap[TIER.CASH]).toBeCloseTo(19000, 9);
    closeAll([capOf(tiers, TIER.CASH, 0), capOf(tiers, TIER.CASH, 1)], [12666.666667, 6333.333333]);
    closeAll([capOf(tiers, TIER.CASH_RESERVE, 0), capOf(tiers, TIER.CASH_RESERVE, 1)], [7333.333333, 3666.666667]);
  });

  it("decision 20 a reserve above the cash leaves tier 1 empty and all the cash in tier 6", () => {
    const tiers = tiersOf(view({ treatment: [CASH], owner: [-1], available: [8000], reserve: 50000 }));
    expect(tiers.cap[TIER.CASH]).toBe(0);
    expect(tiers.cap[TIER.CASH_RESERVE]).toBe(8000);
  });
});

/** mulberry32: the test's own seeded generator. */
function generator(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("fill is continuous and non-decreasing in every account (what the solver needs)", () => {
  it("fill over 500 seeded random views: Σw = min(x, total); 0 ≤ w ≤ available; fill(total) = available; every w non-decreasing and 1-Lipschitz in x", () => {
    const kinds = [CASH, TAXABLE, PRE_TAX, ROTH, HSA];
    for (let n = 0; n < 500; n++) {
      const rnd = generator(0x7e000000 + n);
      const A = 1 + Math.floor(rnd() * 8);
      const treatment = Array.from({ length: A }, () => kinds[Math.floor(rnd() * kinds.length)]!);
      const owner = treatment.map((tr) => (tr === CASH || tr === TAXABLE ? -1 : Math.floor(rnd() * 2)));
      const available = treatment.map(() => (rnd() < 0.15 ? 0 : Math.floor(rnd() * 500000) / 4));
      const v = view({
        treatment,
        owner,
        available,
        share: treatment.map(() => (rnd() < 0.5 ? 0 : rnd() < 0.5 ? 1 : rnd())),
        rothFree: [rnd() * 200000, rnd() * 100000],
        alive: [1, rnd() < 0.9 ? 1 : 0],
        cpi: 1 + rnd(),
        f: rnd() < 0.3 ? (1 + Math.floor(rnd() * 11)) / 12 : 1,
        reserve: rnd() < 0.5 ? rnd() * 50000 : 0,
      });
      const tiers = tiersOf(v, rnd() * 20000);
      const total = available.reduce((x, y) => x + y, 0);
      expect(tiers.total).toBeCloseTo(total, 6);
      let sumCaps = 0;
      for (let a = 0; a < A; a++) {
        let s = 0;
        for (let k = 0; k < TIER_COUNT; k++) {
          const c = capOf(tiers, k, a);
          expect(c, `view ${n} account ${a} tier ${k}`).toBeGreaterThanOrEqual(0);
          s += c;
        }
        expect(s, `view ${n} account ${a}`).toBeCloseTo(available[a]!, 6);
        sumCaps += s;
      }
      expect(sumCaps).toBeCloseTo(total, 6);
      closeAll(take(tiers, 0), available.map(() => 0));
      closeAll(take(tiers, total), available, 6);
      closeAll(take(tiers, total + 1000), available, 6);
      let prev = take(tiers, 0);
      let prevX = 0;
      for (let j = 1; j <= 40; j++) {
        const x = (total * j) / 40 - (j < 40 ? rnd() * (total / 80) : 0);
        const w = take(tiers, x);
        const sum = w.reduce((p, q) => p + q, 0);
        expect(sum, `view ${n} x ${x}`).toBeCloseTo(Math.min(x, total), 6);
        for (let a = 0; a < A; a++) {
          expect(w[a]!, `view ${n} account ${a}`).toBeGreaterThanOrEqual(prev[a]! - 1e-9);
          expect(w[a]! - prev[a]!, `view ${n} account ${a}`).toBeLessThanOrEqual(x - prevX + 1e-6);
          expect(w[a]!).toBeLessThanOrEqual(available[a]! + 1e-9);
        }
        prev = w;
        prevX = x;
      }
    }
  });

  it("fill takes the tiers in order: nothing from a later tier while an earlier one has room", () => {
    // Cash 1,000 (tier 1), taxable 2,000 (tier 3), pre-tax 3,000 (tier 4): 2,500 is 1,000 + 1,500.
    const tiers = tiersOf(view({ treatment: [PRE_TAX, TAXABLE, CASH], owner: [0, -1, -1], available: [3000, 2000, 1000] }));
    closeAll(take(tiers, 2500), [0, 1500, 1000]);
    closeAll(take(tiers, 3000), [0, 2000, 1000]);
    closeAll(take(tiers, 3001), [1, 2000, 1000]);
  });
});
