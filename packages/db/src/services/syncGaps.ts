import { eq, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../index.js";
import { connection, type ConnectionError } from "../schema/index.js";

const SYNC_GAP = "sync.gap";

/**
 * Audit a3-sync-core, second round: what a sync writes to `connection.last_errors`.
 *
 * The entries describe the last response and are replaced by the next one (a failed sync
 * empties them, audit decision 28), with one exception: a `sync.gap` notice. It names days the
 * feed was not asked for again because the first-sync cap cut the window, a hole no later sync
 * fills (each window starts later). Replaced like the others, it was on the Connections page for
 * one sync interval at most, and gone at once after a Balances only refresh. So a notice that
 * names its days (`from`, `to`) stays through later syncs, refreshes, failed syncs and syncs a
 * dead worker left behind, until the household dismisses it (`dismissSyncGap`). A new notice
 * with the same first day is the same outage, longer: it replaces the old one instead of
 * standing next to it. A notice without its days (written before they were recorded) goes with
 * the next sync, as every notice used to.
 *
 * The value is computed inside the UPDATE, from the row as it is then, so a notice dismissed
 * while a sync was running stays dismissed.
 */
export function lastErrorsKeepingSyncGaps(entries: readonly ConnectionError[]): SQL {
  const replaced = entries.flatMap((e) => (e.code === SYNC_GAP && typeof e.from === "string" ? [e.from] : []));
  // Raw identifiers: in an UPDATE drizzle would print the column unqualified, which inside the subquery is still the row's; qualified, it says so.
  return sql`coalesce((
    select jsonb_agg(x.e order by x.ord)
    from jsonb_array_elements("connection"."last_errors") with ordinality as x(e, ord)
    where x.e->>'code' = ${SYNC_GAP}
      and jsonb_typeof(x.e->'from') = 'string'
      and jsonb_typeof(x.e->'to') = 'string'
      and not jsonb_exists(${JSON.stringify(replaced)}::jsonb, x.e->>'from')
  ), '[]'::jsonb) || ${JSON.stringify(entries)}::jsonb`;
}

/**
 * Remove the `sync.gap` notice whose first day is `from` (the household imported a CSV for
 * those days, or decided nothing is missing). Everything else on the connection stays. True
 * when the connection exists, whether or not it carried that notice.
 */
export async function dismissSyncGap(db: DbOrTx, connectionId: string, from: string): Promise<boolean> {
  const rows = await db
    .update(connection)
    .set({
      lastErrors: sql`coalesce((
        select jsonb_agg(x.e order by x.ord)
        from jsonb_array_elements("connection"."last_errors") with ordinality as x(e, ord)
        where not (x.e->>'code' = ${SYNC_GAP} and x.e->>'from' is not distinct from ${from})
      ), '[]'::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(connection.id, connectionId))
    .returning({ id: connection.id });
  return rows.length > 0;
}
