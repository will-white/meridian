import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { account, connection, importCsvRows, importLog, transaction } from "@meridian/db";
import { CsvCommitBody, CsvMapping, CsvPreviewBody, CsvPreviewResponse, guessCsvMapping, ImportResult, mapCsvRows, parseCsv, type CsvMappingInput } from "@meridian/shared";
import { badRequest, notFound } from "../lib/errors.js";

export async function importRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  async function existingIds(accountId: string, ids: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await app.db
        .select({ externalId: transaction.externalId })
        .from(transaction)
        .where(and(eq(transaction.accountId, accountId), inArray(transaction.externalId, ids.slice(i, i + 500))));
      for (const row of rows) if (row.externalId) out.add(row.externalId);
    }
    return out;
  }

  r.post("/import/csv/preview", { schema: { body: CsvPreviewBody, response: { 200: CsvPreviewResponse } } }, async (request) => {
    const rows = parseCsv(request.body.csvText);
    if (rows.length === 0) throw badRequest("The file is empty", "empty_csv");
    let mapping: CsvMappingInput | undefined = request.body.mapping;
    if (!mapping && request.body.profileId) {
      const [profile] = await app.db.select().from(connection).where(eq(connection.id, request.body.profileId));
      if (!profile?.csvMapping) throw notFound("Mapping profile not found");
      const parsed = CsvMapping.safeParse(profile.csvMapping);
      if (!parsed.success) throw badRequest("The saved mapping is no longer valid; rebuild it", "bad_profile");
      mapping = parsed.data;
    }
    const headers = rows[0]!;
    if (!mapping) mapping = guessCsvMapping(headers, rows.slice(1, 6));

    const sampleRows = rows.slice(0, 6);
    if (!mapping) return { headers, sampleRows, mapping: null, rows: [], totalRows: Math.max(rows.length - 1, 0), duplicateCount: 0, errors: [] };

    let mapped: Awaited<ReturnType<typeof mapCsvRows>>;
    try {
      mapped = await mapCsvRows(rows, mapping);
    } catch (err) {
      throw badRequest((err as Error).message, "bad_mapping");
    }
    const dupes = request.body.accountId ? await existingIds(request.body.accountId, mapped.rows.map((m) => m.externalId)) : new Set<string>();
    return {
      headers: mapping.hasHeader === false ? headers.map((_, i) => `Column ${i + 1}`) : headers,
      sampleRows,
      mapping: CsvMapping.parse(mapping),
      rows: mapped.rows.slice(0, 200).map((m) => ({
        rowIndex: m.rowIndex,
        date: m.date,
        amountCents: m.amountCents.toString(),
        description: m.description,
        ...(m.memo ? { memo: m.memo } : {}),
        externalId: m.externalId,
        duplicate: dupes.has(m.externalId),
      })),
      totalRows: mapped.rows.length,
      duplicateCount: dupes.size,
      errors: mapped.errors.slice(0, 50),
    };
  });

  r.post("/import/csv/commit", { schema: { body: CsvCommitBody, response: { 200: ImportResult } } }, async (request) => {
    const [acct] = await app.db.select({ id: account.id }).from(account).where(eq(account.id, request.body.accountId));
    if (!acct) throw notFound("Account not found");
    const rows = parseCsv(request.body.csvText);
    let mapped: Awaited<ReturnType<typeof mapCsvRows>>;
    try {
      mapped = await mapCsvRows(rows, request.body.mapping);
    } catch (err) {
      throw badRequest((err as Error).message, "bad_mapping");
    }
    if (mapped.rows.length === 0) throw badRequest("No rows could be read with this mapping", "no_rows");

    let profileId: string | null = null;
    if (request.body.saveProfile) {
      const name = request.body.saveProfile.name.trim();
      if (request.body.saveProfile.id) {
        const [updated] = await app.db
          .update(connection)
          .set({ name, csvMapping: request.body.mapping, updatedAt: new Date() })
          .where(and(eq(connection.id, request.body.saveProfile.id), eq(connection.type, "csv")))
          .returning({ id: connection.id });
        profileId = updated?.id ?? null;
      }
      if (!profileId) {
        const [created] = await app.db.insert(connection).values({ type: "csv", name, csvMapping: request.body.mapping }).returning({ id: connection.id });
        profileId = created!.id;
      }
    }

    const [log] = await app.db
      .insert(importLog)
      .values({ connectionId: profileId, kind: "csv", rawPayload: { csvText: request.body.csvText, mapping: request.body.mapping } })
      .returning({ id: importLog.id });
    try {
      const result = await importCsvRows(app.db, { accountId: acct.id, rows: mapped.rows, importLogId: log!.id });
      await app.db
        .update(importLog)
        .set({ status: "ok", finishedAt: new Date(), stats: { ...result, rowsRead: mapped.rows.length, rowsRejected: mapped.errors.length } })
        .where(eq(importLog.id, log!.id));
      if (profileId) await app.db.update(connection).set({ lastSyncAt: new Date(), status: "ok" }).where(eq(connection.id, profileId));
      return { ...result, errors: mapped.errors };
    } catch (err) {
      await app.db.update(importLog).set({ status: "error", finishedAt: new Date(), message: (err as Error).message }).where(eq(importLog.id, log!.id));
      throw err;
    }
  });
}
