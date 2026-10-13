/**
 * Meridian worker: runs scheduled jobs outside the request path.
 * Phase 1: SimpleFIN sync every SYNC_INTERVAL_HOURS.
 * Later: price fetch, recurring detection, retirement simulations.
 */
const intervalHours = Number(process.env.SYNC_INTERVAL_HOURS ?? 6);

async function syncAll() {
  // Phase 1: load connections of type simplefin, call GET /accounts?version=2 with an
  // overlapping start-date, write raw payload to import_log, upsert transactions.
  console.log(`[worker] sync tick (${new Date().toISOString()})`);
}

await syncAll();
setInterval(() => void syncAll(), intervalHours * 60 * 60 * 1000);
