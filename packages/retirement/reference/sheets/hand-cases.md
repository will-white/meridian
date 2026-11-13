# Hand cases re-derived in step 5: HC-T15, HC-S3, WD-5, WD-15

**Status.** `docs/design/phase-4/seams.md` §10 and `docs/phase-4-plan.md` decision 10 withdraw four expected values of `docs/design/phase-4/strategies-outputs-web.md` (§7.2, §7.5), because they were computed with thresholds multiplied by the price level unrounded and with Social Security as `12 × benefit × cpi`. This page re-derives them under the rules the engine implements: the statute's rounding steps for every threshold after 2027 (seams C22) and SSA's truncation of benefits (C21, C20). Each value below is derived by hand here and was reproduced by the step-5 scratch reference; the R1 and R2 reference sheets (`r1.md`, `r2.md` beside this file) carry the full years they come from. The test that owns each case uses the new value with this derivation in its comments.

| Case | Owner (build step) | Superseded value | New expected value |
| --- | --- | --- | --- |
| HC-T15 | tax area (indexing, step 7) | 37,515.00 | **37,400.00** |
| HC-S3 (a) | tax area (Social Security, step 10) | 36,552.09 | **36,540.00** |
| HC-S3 (b) | tax area (Social Security, step 10) | 37,822.50 | **37,812.00** |
| WD-5 | strategies area (withdrawals, step 19) | taxable 133,550.95; gain 54,056.34; ordinary tax 8,548.61; gains tax 3,752.34 | **taxable 133,585.74; gain 54,070.42; ordinary tax 8,563.41; gains tax 3,772.33** (total 12,335.74) |
| WD-15 | strategies area (withdrawals, step 19) | taxable 43,539.05; pre-tax 21,062.59 and 8,834.51; tax 5,520.10 | **taxable 43,442.14; pre-tax 21,170.38 and 8,879.72; tax 5,560.56** |

Rules used (each is stated in full in `r1.md` §2 and `r2.md` §2):

- Indexing after the last published year, 2027: `F_2027 = 1`, `F_Y = F_{Y−1} × (1 + inflation of year Y − 1)`; `v_Y = v_2027 + floor(v_2027 × (F_Y − 1) / step + 1e−9) × step`. Joint steps: bracket thresholds 50, standard deduction 100, additional deduction per aged spouse 50, 0% and 15% gains maxima 50.
- Social Security: in January of each year after the plan's first, `PIA ← floorDime(PIA × (1 + COLA))` with `floorDime(z) = floor(z × 10 + 1e−9) / 10`; the COLA is the previous year's inflation rounded to 0.1% (2.5% here); the monthly payment is `floorDollar(max(own + spousal, widow's))` with `floorDollar(z) = floor(z + 1e−9)`; the year's benefit is the sum of the year's monthly payments.

## HC-T15. Indexing after the last published year

**Case.** Tax year 2028, married filing jointly, both spouses 65 or older, path inflation 2.5% in 2027 (so `F_2028 = 1.025`): the standard deduction with the two additional amounts for age.

**Derivation.**

- Standard deduction: `33,200 + floor(33,200 × 0.025 / 100 + 1e−9) × 100 = 33,200 + floor(8.3) × 100 = 33,200 + 800 = 34,000`.
- Additional amount per aged spouse: `1,700 + floor(1,700 × 0.025 / 50 + 1e−9) × 50 = 1,700 + floor(0.85) × 50 = 1,700` (the increase of 42.50 is below the 50 step).
- Total: `34,000 + 2 × 1,700 =` **37,400.00**.

The superseded value multiplied the 2027 total by the price level: `36,600 × 1.025 = 37,515.00`. In the same year the first joint bracket ends at `25,600 + floor(640 / 50) × 50 = 26,200` (was 26,240.00). The tax design's J1 (inflation 3%) gives 34,100 and 1,750 for 2028 by the same rule.

## HC-S3. Survivor and cost-of-living, with SSA's rounding

**(a) The survivor receives the larger benefit (R2, 2035).** Person 1 (born January 1958) has been paid since his full retirement age (September 2024) on a PIA of 2,500.00 in 2027 dollars; he dies at the end of 2034. Person 2 (born January 1961) claimed at her full retirement age in January 2028 on a PIA of 1,500.00 in 2027 dollars. COLA 2.5% from 2028.

- Person 1's PIA, which keeps its adjustments after his death: 2,500.00 → 2028 `2,562.5` → 2029 `2,626.5625 → 2,626.5` → 2030 `2,692.1625 → 2,692.1` → 2031 `2,759.4025 → 2,759.4` → 2032 `2,828.385 → 2,828.3` → 2033 `2,899.0075 → 2,899.0` → 2034 `2,971.475 → 2,971.4` → 2035 `3,045.685 → 3,045.6`.
- Person 2's own PIA in 2035: 1,500.00 → 1,537.5 → 1,575.9 → 1,615.2 → 1,655.5 → 1,696.8 → 1,739.2 → 1,782.6 → **1,827.1**; her own benefit at factor 1 is 1,827.10.
- Widow's benefit from January 2035: the deceased claimed at full retirement age, so his factor `d = 1` and no widow's limit applies; person 2 is 74 (888 months), past her survivor full retirement age (802 months, the table at birth year 1959), so the survivor factor is 1: `floorDime(3,045.6 × 1 × 1) = 3,045.60`.
- Payment `floorDollar(max(1,827.10, 3,045.60)) = 3,045` a month; the year: `12 × 3,045 =` **36,540.00**.

The superseded value was `30,000 × 1.025^8 = 36,552.09`.

**(b) A benefit quoted in plan-start dollars, in the third plan year.** A PIA of 3,000.00 a month (36,000 a year) as of 2027, the plan's first year, claimed at full retirement age and in pay for the whole of 2029 (R1's person A), with 2.5% inflation:

- 2028: `3,000 × 1.025 = 3,075.0`; 2029: `3,075.0 × 1.025 = 3,151.875`, truncated to the dime: 3,151.8.
- Payment `floorDollar(3,151.8) = 3,151` a month; 2029: `12 × 3,151 =` **37,812.00**.

The superseded value was `36,000 × 1.025² = 37,822.50`. (R1's person B in the same year: 1,800 → 1,845.0 → 1,891.125 → 1,891.1, paid 1,891 a month, 22,692.00; the couple's 60,504.00 is the figure seams.md C50 gives.)

## WD-5. R1 2028: gains reach the 15% band while the senior deduction phases out

**Case.** R1's year 2028 (`r1.md`): joint, both 66; pension 12,000; A's conversion 110,000; need `130,000 × 1.025 = 133,250`; no Social Security yet; the cash account is empty, so the withdrawal comes from the taxable account (start of year 333,169.20 at basis 198,315.00, all stocks). 2028 joint law (`F = 1.025`): 12% from 26,200; standard `34,000 + 2 × 1,700 = 37,400`; 0% gains up to 104,650; senior deduction `2 × max(0, 6,000 − 6% × (AGI − 150,000))`.

**Derivation.** The gain fraction is `1 − 198,315 / 333,169.20 = 17/42`; let `x` be the withdrawal and `g = 17x/42` its gain.

- AGI `= 122,000 + g`; with AGI between 150,000 and 250,000 the senior deduction is `12,000 − 0.12 × (AGI − 150,000) = 15,360 − 0.12 g`.
- Taxable income `= AGI − 37,400 − senior = 69,240 + 1.12 g`; ordinary taxable income `= 69,240 + 0.12 g` (in the 12% bracket); ordinary tax `= 2,620 + 0.12 × (43,040 + 0.12 g) = 7,784.80 + 0.0144 g`.
- Gains at 0%: `104,650 − (69,240 + 0.12 g) = 35,410 − 0.12 g`; at 15%: `g − (35,410 − 0.12 g) = 1.12 g − 35,410`; gains tax `= 0.168 g − 5,311.50`.
- Total tax `= 2,473.30 + 0.1824 g`. Cash: `x + 12,000 − tax = 133,250`, so `x × (1 − 0.1824 × 17/42) = 123,723.30` and `x = 123,723.30 × 42 / 38.8992 = 133,585.7447`.
- Expected: taxable **133,585.74**; gain `17/42 × 133,585.7447 =` **54,070.42**; ordinary tax `7,784.80 + 0.0144 × 54,070.42 =` **8,563.41**; gains tax `0.168 × 54,070.42 − 5,311.50 =` **3,772.33**; total 12,335.74. Checks: AGI 176,070.42; senior 8,871.55; taxable income 129,798.87; `133,585.74 − (12,335.74 − 8,188.00) = 129,438.00`, the need less the pension less the tax the year owes without a withdrawal (8,188.00).

## WD-15. R1 2031: the taxable account runs out mid-year

**Case.** R1's year 2031: joint, both 69; `cpi` 1.1038128906; need `130,000 × cpi = 143,495.6758`; pension 12,000; benefits `39,732 + 23,832 = 63,564` (PIAs 3,311.2 and 1,986.7 after four adjustments, paid 3,311 and 1,986 a month); no RMD yet; the senior deduction has ended. 2031 joint law (`F = 1.1038128906`): 12% from 28,250 (tax at that bound 2,825); standard `36,600 + 2 × 1,850 = 40,300`; 0% gains up to 112,650. Start of the year: taxable 43,442.1430 at basis 22,337.4741; pre-tax A 869,376.375 and B 364,651.875.

**Derivation.**

- The taxable tier is emptied: `T = 43,442.1430`, gain `G = T × (1 − 22,337.4741 / 43,442.1430) = 21,104.6689`. The rest, `y`, comes from the two pre-tax accounts pro rata to their available balances.
- Provisional income `= 12,000 + y + G + 31,782 = 64,886.6689 + y`; while benefits phase in, taxable benefits `= 0.85 × (PI − 44,000) + 6,000 = 23,753.6686 + 0.85 y` (below the cap `0.85 × 63,564 = 54,029.40`).
- AGI `= 12,000 + G + 23,753.6686 + 1.85 y = 56,858.3375 + 1.85 y`; taxable income `= 16,558.3375 + 1.85 y`; ordinary taxable `= 1.85 y − 4,546.3314`; ordinary tax `= 2,825 + 0.12 × (1.85 y − 32,796.3314) = 0.222 y − 1,110.5598`; the gain stays at 0% (taxable income under 112,650).
- Cash: `T + y − tax = 143,495.6758 − 75,564 = 67,931.6758`, so `0.778 y = 67,931.6758 − 43,442.1430 − 1,110.5598 = 23,378.9730` and `y = 30,050.0938`.
- Pro rata: A `30,050.0938 × 869,376.375 / 1,234,028.25 = 21,170.38`; B `30,050.0938 × 364,651.875 / 1,234,028.25 = 8,879.72`.
- Expected: taxable **43,442.14**; pre-tax **21,170.38** and **8,879.72**; tax `0.222 × 30,050.0938 − 1,110.5598 =` **5,560.56**. Checks: taxable benefits 49,296.25; AGI 112,451.01; taxable income 72,151.01, of which ordinary 51,046.34.
