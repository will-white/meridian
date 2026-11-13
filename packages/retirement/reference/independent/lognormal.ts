// R4: the lognormal sanity check (r4.md), with this calculator's own generator: mulberry32 for
// uniforms and Box–Muller for normals (strategies-outputs-web §7.9; r4.md §2), not the engine's
// counter-based generator.

/**
 * mulberry32 (Tommy Ettinger, public domain): a 32-bit state advanced by the Weyl constant
 * 0x6D2B79F5 and mixed into one 32-bit output. The state is a counter, so the stream can be cut
 * into disjoint blocks by setting the state to `seed + offset × 0x6D2B79F5` (mod 2^32).
 */
export class Mulberry32 {
  private state: number;

  constructor(seed: number, offset = 0) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError(`seed must be a uint32: ${seed}`);
    if (!Number.isInteger(offset) || offset < 0 || offset > 0x7fffffff) throw new RangeError(`offset out of range: ${offset}`);
    this.state = (seed + Math.imul(offset, 0x6d2b79f5)) | 0;
  }

  /** The next output as an unsigned 32-bit integer. */
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** A uniform in the open interval (0, 1): (x + 0.5) / 2^32, never 0 (so the logarithm is finite). */
  nextOpenUniform(): number {
    return (this.nextUint32() + 0.5) / 4294967296;
  }
}

/** Box–Muller: two uniforms give two independent standard normals. */
export function boxMuller(rng: Mulberry32): [number, number] {
  const u1 = rng.nextOpenUniform();
  const u2 = rng.nextOpenUniform();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

/** r4.md §2: σ² = ln(1 + (S ÷ (1 + A))²), μ = ln(1 + A) − σ² ÷ 2, for a growth factor of mean 1 + A and standard deviation S. */
export function lognormalParameters(meanBp: number, volBp: number): { mu: number; sigma: number } {
  const a = meanBp / 10000;
  const sd = volBp / 10000;
  const variance = Math.log(1 + (sd / (1 + a)) ** 2);
  return { mu: Math.log(1 + a) - variance / 2, sigma: Math.sqrt(variance) };
}

export const R4_PARAMETERS = {
  planYears: 30,
  startBalance: 1_000_000,
  baseSpending: 40_000,
  stocks: { meanBp: 600, volBp: 1200 },
  inflation: { meanBp: 250, volBp: 100 },
  // Bonds 400 / 700 and bills 300 / 200 are part of the input but unused by the all-stock account.
  bonds: { meanBp: 400, volBp: 700 },
  bills: { meanBp: 300, volBp: 200 },
} as const;

/** Uniforms one path consumes: one Box–Muller pair (z_S, z_π) per plan year. */
export const UNIFORMS_PER_PATH = 2 * R4_PARAMETERS.planYears;

export interface LognormalRun {
  readonly paths: number;
  readonly successPaths: number;
  /** Ending wealth in today's dollars, in cents, per path. */
  readonly endRealCents: Float64Array;
  /** First failing plan-year index per path, −1 for never. */
  readonly failIndex: Int16Array;
}

/**
 * `paths` paths from the stream block that starts `offset` uniforms into the seed's stream. Each
 * plan year draws z_S, z_π (one Box–Muller pair), withdraws 40,000 × cpi[t] at its start (what is
 * left when the balance is short, and the path has failed), then multiplies the balance by
 * g = exp(μ_S + σ_S z_S) and the price level by p = exp(μ_π + σ_π z_π). A failed path keeps drawing
 * so that every path uses the same number of uniforms.
 */
export function runLognormal(paths: number, seed: number, offset: number): LognormalRun {
  const s = lognormalParameters(R4_PARAMETERS.stocks.meanBp, R4_PARAMETERS.stocks.volBp);
  const p = lognormalParameters(R4_PARAMETERS.inflation.meanBp, R4_PARAMETERS.inflation.volBp);
  const rng = new Mulberry32(seed, offset);
  const endRealCents = new Float64Array(paths);
  const failIndex = new Int16Array(paths);
  let successPaths = 0;
  for (let k = 0; k < paths; k++) {
    let balance: number = R4_PARAMETERS.startBalance;
    let cpi = 1;
    let failed = -1;
    for (let t = 0; t < R4_PARAMETERS.planYears; t++) {
      const [zS, zPi] = boxMuller(rng);
      const need = R4_PARAMETERS.baseSpending * cpi;
      if (balance >= need) balance -= need;
      else {
        balance = 0;
        if (failed < 0) failed = t;
      }
      balance *= Math.exp(s.mu + s.sigma * zS);
      cpi *= Math.exp(p.mu + p.sigma * zPi);
    }
    const real = balance / cpi;
    endRealCents[k] = Math.floor(real * 100 + 0.5 + 1e-7);
    failIndex[k] = failed;
    if (failed < 0) successPaths++;
  }
  return { paths, successPaths, endRealCents, failIndex };
}
