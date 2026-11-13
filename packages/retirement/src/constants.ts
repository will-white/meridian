/**
 * Engine-wide constants that more than one module reads (engine-and-returns §2.1).
 */

/**
 * Half a cent, in dollars: the tolerance of the cash identity (engine-and-returns §2.1 and §3.9,
 * strategies-outputs-web decision 8 and §3.6). A floor counts as funded when `funded + CASH_TOL ≥
 * floorNeed`; the gross-up stops at `|net| ≤ CASH_TOL`; a trade may overdraw an account by at most
 * this much of rounding before it is an invariant error.
 */
export const CASH_TOL = 0.005;
