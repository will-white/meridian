import { count } from "drizzle-orm";
import type { DbOrTx } from "../index.js";
import { category } from "../schema/index.js";

export const DEFAULT_CATEGORIES: Array<{ name: string; bucket: "income" | "bills" | "savings" | "spending" }> = [
  { name: "Paycheck", bucket: "income" },
  { name: "Interest & Dividends", bucket: "income" },
  { name: "Other Income", bucket: "income" },
  { name: "Rent / Mortgage", bucket: "bills" },
  { name: "Utilities", bucket: "bills" },
  { name: "Phone & Internet", bucket: "bills" },
  { name: "Insurance", bucket: "bills" },
  { name: "Subscriptions", bucket: "bills" },
  { name: "Loan Payment", bucket: "bills" },
  { name: "Savings", bucket: "savings" },
  { name: "Retirement Contribution", bucket: "savings" },
  { name: "Groceries", bucket: "spending" },
  { name: "Dining", bucket: "spending" },
  { name: "Fuel", bucket: "spending" },
  { name: "Transportation", bucket: "spending" },
  { name: "Shopping", bucket: "spending" },
  { name: "Entertainment", bucket: "spending" },
  { name: "Health", bucket: "spending" },
  { name: "Personal Care", bucket: "spending" },
  { name: "Home", bucket: "spending" },
  { name: "Gifts", bucket: "spending" },
  { name: "Travel", bucket: "spending" },
  { name: "Pets", bucket: "spending" },
  { name: "Fees & Charges", bucket: "spending" },
];

/** Insert the default categories when the table is empty (first run). */
export async function seedDefaultCategories(tx: DbOrTx): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(category);
  if ((row?.n ?? 0) > 0) return 0;
  await tx.insert(category).values(DEFAULT_CATEGORIES).onConflictDoNothing();
  return DEFAULT_CATEGORIES.length;
}
