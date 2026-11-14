-- Audit a8-ledger-ui-10: a transfer has no split (Phase 2 plan A5). Rows marked or paired as a
-- transfer before every transfer path removed the lines kept them; their lines leave the plan's
-- readers (the register's category filter listed such a row as spending).
DELETE FROM "split" WHERE "transaction_id" IN (SELECT "id" FROM "transaction" WHERE "is_transfer" = true);
