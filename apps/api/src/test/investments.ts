import * as OTPAuth from "otpauth";
import { INV_SEED_NOW, seedInvestmentFixture, seedInvestmentLots, type InvestmentSeed } from "@meridian/db/testing";
import { createTestApp, viewerCookies, type TestApp } from "./helpers.js";

/**
 * A test app on the Phase 3 INV seed (docs/design/phase-3/views-and-api.md §7.0) with the
 * owner signed in and two-factor verified: the server clock is `INV_SEED_NOW`
 * (2026-10-14 12:00 in Denver, before the US close, so the expected price date is 10-13).
 * `lots: true` also rebuilds the derived lots cache (B's four buys).
 */
export interface InvestmentApp {
  t: TestApp;
  S: InvestmentSeed;
  /** B's lot ids by the seed's txn keys when `lots` was requested. */
  lotIds: Record<string, string>;
}

export async function freshInvestmentApp(options: { lots?: boolean } = {}): Promise<InvestmentApp> {
  const t = await createTestApp({ now: () => INV_SEED_NOW });
  const S = await seedInvestmentFixture(t.db.db);
  let lotIds: Record<string, string> = {};
  if (options.lots) ({ lotIds } = await seedInvestmentLots(t.db.db, S));
  await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
  const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
  await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
  return { t, S, lotIds };
}

export { viewerCookies };
