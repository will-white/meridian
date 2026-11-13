// Social Security by the month, with SSA's truncation, as r1.md §2.5 and r2.md §2.5 state it.
// Independent of packages/retirement/src: written from the sheets only.
//
// Unverified (seams.md §9 item 1; www.ssa.gov refuses automated requests): the full-retirement-age
// rows, the survivor table shift, the 28.5% survivor reduction at 60, the truncation rules and the
// COLA rounding. They are transcribed from the sheets as stated there.

export const monthIndex = (year: number, month: number): number => 12 * year + month - 1;

/** Full retirement age in months by birth year (the rows the sheets give). */
export function fraMonths(birthYear: number): number {
  if (birthYear === 1958) return 800; // 66 years 8 months
  if (birthYear === 1959) return 802; // 66 years 10 months
  if (birthYear >= 1960) return 804; // 67 years
  throw new RangeError(`no full retirement age transcribed for birth year ${birthYear}`);
}

/** Survivor full retirement age: the retirement table read at birth year − 2 (r2.md §2.5). */
export const survivorFraMonths = (birthYear: number): number => fraMonths(birthYear - 2);

export const floorDime = (z: number): number => Math.floor(z * 10 + 1e-9) / 10;
export const floorDollar = (z: number): number => Math.floor(z + 1e-9);

export interface SsPerson {
  readonly id: string;
  readonly birthYear: number;
  readonly birthMonth: number;
  /** Primary insurance amount in plan-start (asOfYear = startYear) dollars. */
  readonly pia: number;
  /** First month in pay: the claim month of an estimate, the start month of a benefit in pay. */
  readonly claimYear: number;
  readonly claimMonth: number;
  /** Last calendar year the person is alive (deaths take effect at the year end). */
  readonly lastAliveYear: number;
}

export interface SsYear {
  readonly year: number;
  readonly cola: number;
  readonly pia: Readonly<Record<string, number>>;
  readonly monthly: Readonly<Record<string, number>>;
  readonly annual: Readonly<Record<string, number>>;
}

/** The retirement factor at the claim: 1 at full retirement age (the only case the sheets exercise). */
function retirementFactor(p: SsPerson): number {
  const claimAge = monthIndex(p.claimYear, p.claimMonth) - monthIndex(p.birthYear, p.birthMonth);
  if (claimAge !== fraMonths(p.birthYear)) {
    throw new RangeError(`${p.id}: claims away from full retirement age are not exercised by the sheets`);
  }
  return 1;
}

/**
 * The benefit chain from the plan's first year to its last. `inflation[k]` is the full-year
 * inflation rate of plan year k (calendar year startYear + k).
 */
export function socialSecurityChain(
  people: readonly SsPerson[],
  startYear: number,
  endYear: number,
  inflation: readonly number[],
): SsYear[] {
  if (people.length > 2) throw new RangeError("at most two people");
  const pia = new Map(people.map((p) => [p.id, p.pia]));
  const factor = new Map(people.map((p) => [p.id, retirementFactor(p)]));
  let level = 1; // P_Y
  let highWater = 1; // H: the level at the last adjustment
  const out: SsYear[] = [];
  for (let year = startYear; year <= endYear; year++) {
    let cola = 0;
    if (year > startYear) {
      level = level * (1 + (inflation[year - 1 - startYear] as number));
      const raw = level / highWater - 1;
      cola = Math.max(0, Math.floor(raw * 1000 + 0.5) / 1000);
      if (cola > 0) highWater = level;
      // In January every PIA, the deceased's included, is adjusted and truncated to the dime.
      for (const p of people) pia.set(p.id, floorDime((pia.get(p.id) as number) * (1 + cola)));
    }
    const monthly: Record<string, number> = {};
    const annual: Record<string, number> = {};
    for (const p of people) {
      monthly[p.id] = 0;
      annual[p.id] = 0;
      if (year > p.lastAliveYear) continue;
      const partner = people.find((q) => q.id !== p.id);
      const ownPia = pia.get(p.id) as number;
      const f = factor.get(p.id) as number;
      for (let month = 1; month <= 12; month++) {
        const idx = monthIndex(year, month);
        const claimed = idx >= monthIndex(p.claimYear, p.claimMonth);
        const own = claimed ? floorDime(ownPia * f) : 0;
        let spousal = 0;
        let widow = 0;
        if (partner !== undefined) {
          const partnerPia = pia.get(partner.id) as number;
          const partnerAlive = year <= partner.lastAliveYear;
          const partnerClaimed = idx >= monthIndex(partner.claimYear, partner.claimMonth);
          if (partnerAlive && claimed && partnerClaimed) {
            const spousalFactor = 1; // claimed at full retirement age
            spousal = Math.max(0, 0.5 * partnerPia - ownPia * Math.max(1, f)) * spousalFactor;
          }
          const ageMonths = idx - monthIndex(p.birthYear, p.birthMonth);
          if (!partnerAlive && year > partner.lastAliveYear && ageMonths >= 720) {
            const d = factor.get(partner.id) as number; // the deceased's factor in pay in December of death
            const sfra = survivorFraMonths(p.birthYear);
            const survivorFactor = 1 - (0.285 * Math.max(0, sfra - ageMonths)) / (sfra - 720);
            let w = partnerPia * Math.max(1, d) * survivorFactor;
            if (d < 1) w = Math.min(w, Math.max(partnerPia * d, 0.825 * partnerPia));
            widow = floorDime(w);
          }
        }
        const payment = claimed || widow > 0 ? floorDollar(Math.max(own + spousal, widow)) : 0;
        if (month === 12) monthly[p.id] = payment;
        annual[p.id] = (annual[p.id] as number) + payment;
      }
    }
    out.push({ year, cola, pia: Object.fromEntries(pia), monthly, annual });
  }
  return out;
}
