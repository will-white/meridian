import { addDays, dayDiff, formatCents, isoDateToUtcMs, type IsoDate, type SimplefinAccountSet } from "@meridian/shared";

/**
 * A deterministic three-month household, rendered as the SimpleFIN Account Set the
 * Bridge would return for a given window and "as of" day. Card purchases go through
 * the pending -> posted lifecycle (new id, slightly different description, two days later),
 * card payments and savings sweeps are transfers, and one pending charge never posts.
 */

export const FIXTURE_START: IsoDate = "2026-07-01";
export const FIXTURE_END: IsoDate = "2026-10-01"; // 93 days: Jul 1 .. Oct 1 inclusive

export const ACCOUNTS = {
  checking: { id: "ACT-CHK-001", name: "Everyday Checking", balance: "4210.55", org: "First Example Bank" },
  savings: { id: "ACT-SAV-001", name: "High Yield Savings", balance: "15230.12", org: "First Example Bank" },
  card: { id: "ACT-CARD-001", name: "Sapphire Visa", balance: "-842.19", org: "Example Card Services" },
} as const;

export interface TruthEvent {
  account: keyof typeof ACCOUNTS;
  /** Transaction date. */
  date: IsoDate;
  amount: string;
  description: string;
  /** Posted form, when the item goes through a pending phase. */
  pendingId?: string;
  postedId: string;
  postedDescription?: string;
  /** Days between the transaction date and the post date. */
  postLag: number;
  /** A pending item the bank later dropped (declined). Never posts. */
  neverPosts?: boolean;
  payee?: string;
}

const MERCHANTS: Array<[string, string, number, number]> = [
  // raw pending description, posted description, min cents, max cents
  ["KING SOOPERS #0123", "KING SOOPERS #0123 DENVER CO", 2200, 14500],
  ["SQ *BLUE BOTTLE COFFEE", "SQ *BLUE BOTTLE COFFEE DENVER CO", 450, 1250],
  ["SHELL OIL 57442", "SHELL OIL 57442 AURORA CO", 3200, 6800],
  ["TST* THE LOCAL TAPHOUSE", "TST* THE LOCAL TAPHOUSE DENVER CO", 1800, 7600],
  ["AMAZON.COM*1A2B3C", "AMAZON.COM*1A2B3C AMZN.COM/BILL WA", 900, 9900],
  ["COSTCO WHSE #1234", "COSTCO WHSE #1234 AURORA CO", 6000, 24000],
];

/** Tiny deterministic PRNG so the fixture never changes between runs. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildTruth(): TruthEvent[] {
  const rand = mulberry32(20261001);
  const events: TruthEvent[] = [];
  const days = dayDiff(FIXTURE_START, FIXTURE_END);
  let n = 0;

  // Checking: paychecks every other Friday (Jul 3 is a Friday), rent on the 1st, utilities on the 12th.
  for (let d = 2; d <= days; d += 14) {
    events.push({ account: "checking", date: addDays(FIXTURE_START, d), amount: "2500.00", description: "ACME CORP PAYROLL DIRECT DEP", postedId: `CHK-PAY-${++n}`, postLag: 0 });
  }
  for (const month of ["2026-07", "2026-08", "2026-09", "2026-10"]) {
    const first: IsoDate = `${month}-01`;
    if (first > FIXTURE_END) break;
    events.push({ account: "checking", date: first, amount: "-1800.00", description: "ACH DEBIT RENT PAYMENT OAKWOOD APTS", postedId: `CHK-RENT-${month}`, postLag: 0 });
    const twelfth: IsoDate = `${month}-12`;
    if (twelfth <= FIXTURE_END) {
      const cents = 9500 + Math.floor(rand() * 4000);
      events.push({ account: "checking", date: twelfth, amount: formatCents(BigInt(-cents)), description: "XCEL ENERGY DES:XCELENERGY ID:0000123456 INDN:HOUSEHOLD CO ID:1234567890 WEB", postedId: `CHK-UTIL-${month}`, postLag: 0 });
    }
    // Savings sweep on the 15th: both legs the same day.
    const fifteenth: IsoDate = `${month}-15`;
    if (fifteenth <= FIXTURE_END) {
      events.push({ account: "checking", date: fifteenth, amount: "-500.00", description: "ONLINE TRANSFER TO SAVINGS XXXXXX4321", postedId: `CHK-XFER-${month}`, postLag: 0 });
      events.push({ account: "savings", date: fifteenth, amount: "500.00", description: "ONLINE TRANSFER FROM CHECKING XXXXXX8765", postedId: `SAV-XFER-${month}`, postLag: 0 });
      events.push({ account: "savings", date: `${month}-28`, amount: "12.34", description: "INTEREST PAYMENT", postedId: `SAV-INT-${month}`, postLag: 0 });
    }
    // Card payment on the 5th from checking; the card credits it on the 6th.
    const fifth: IsoDate = `${month}-05`;
    if (fifth <= FIXTURE_END) {
      const cents = 60000 + Math.floor(rand() * 40000);
      events.push({ account: "checking", date: fifth, amount: formatCents(BigInt(-cents)), description: "ONLINE PAYMENT TO SAPPHIRE VISA 1234", postedId: `CHK-CCPAY-${month}`, postLag: 0 });
      events.push({ account: "card", date: addDays(fifth, 1), amount: formatCents(BigInt(cents)), description: "PAYMENT THANK YOU - WEB", postedId: `CARD-PAYRCV-${month}`, postLag: 0 });
    }
  }

  // Card purchases: about three a week, pending for two days.
  let p = 0;
  for (let d = 0; d <= days; d++) {
    const count = rand() < 0.45 ? 1 : rand() < 0.3 ? 2 : 0;
    for (let k = 0; k < count; k++) {
      const [pendingDesc, postedDesc, min, max] = MERCHANTS[Math.floor(rand() * MERCHANTS.length)]!;
      const cents = min + Math.floor(rand() * (max - min));
      p++;
      events.push({
        account: "card",
        date: addDays(FIXTURE_START, d),
        amount: formatCents(BigInt(-cents)),
        description: pendingDesc,
        pendingId: `CARD-PEND-${p}`,
        postedId: `CARD-POST-${p}`,
        postedDescription: postedDesc,
        postLag: 2,
      });
    }
  }

  // One pending charge that the merchant voided: it shows as pending on day 58 and then vanishes.
  events.push({
    account: "card",
    date: addDays(FIXTURE_START, 58),
    amount: "-45.00",
    description: "HOTEL HOLD AUTH",
    pendingId: "CARD-PEND-VOID",
    postedId: "never",
    postLag: 3,
    neverPosts: true,
  });

  return events;
}

export interface RenderOptions {
  /** Window requested with start-date (inclusive). */
  start: IsoDate;
  /** The day the Bridge is answering; nothing later than this is visible. */
  asOf: IsoDate;
  /** Bank balance date and the posting time of day. */
  truth?: TruthEvent[];
}

function unix(date: IsoDate, hour = 12): number {
  return Math.floor(isoDateToUtcMs(date) / 1000) + hour * 3600;
}

/** Render the Account Set the Bridge would return for `start-date=start` on day `asOf`. */
export function renderAccountSet(options: RenderOptions): SimplefinAccountSet {
  const truth = options.truth ?? buildTruth();
  const byAccount = new Map<keyof typeof ACCOUNTS, SimplefinAccountSet["accounts"][number]["transactions"]>();
  for (const key of Object.keys(ACCOUNTS) as Array<keyof typeof ACCOUNTS>) byAccount.set(key, []);

  for (const ev of truth) {
    if (ev.date > options.asOf) continue;
    const postDate = addDays(ev.date, ev.postLag);
    const posted = !ev.neverPosts && postDate <= options.asOf;
    if (ev.neverPosts && postDate <= options.asOf) continue; // vanished
    const visibleDate = posted ? postDate : ev.date;
    if (visibleDate < options.start && ev.date < options.start) continue;
    const list = byAccount.get(ev.account)!;
    if (posted) {
      list.push({
        id: ev.postedId,
        posted: unix(postDate),
        amount: ev.amount,
        description: ev.postedDescription ?? ev.description,
        transaction_date: unix(ev.date, 0),
        pending: false,
      });
    } else {
      list.push({
        id: ev.pendingId ?? ev.postedId,
        posted: 0,
        amount: ev.amount,
        description: ev.description,
        transaction_date: unix(ev.date, 0),
        pending: true,
      });
    }
  }

  return {
    errors: [],
    errlist: [],
    accounts: (Object.keys(ACCOUNTS) as Array<keyof typeof ACCOUNTS>).map((key) => {
      const a = ACCOUNTS[key];
      return {
        org: { domain: "example.test", name: a.org, "sfin-url": "https://bridge.example.test/simplefin" },
        id: a.id,
        name: a.name,
        currency: "USD",
        balance: a.balance,
        "available-balance": a.balance,
        "balance-date": unix(options.asOf, 6),
        transactions: byAccount.get(key)!,
      };
    }),
  };
}

/** How many distinct transactions exist once everything has posted (the void never counts). */
export function expectedFinalCount(truth = buildTruth()): number {
  return truth.filter((e) => !e.neverPosts).length;
}
