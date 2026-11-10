import { sql, type SQL } from "drizzle-orm";
import { account, householdSetting } from "../schema/index.js";

/**
 * What the spending plan reads (Phase 3, plan decision 15): rows of on-budget accounts, plus
 * rows in the household's investment income category (the feed) from any account. The query
 * must join `account` on the transaction's account. `categoryExpr` is the row's effective
 * category (a split line's, else the transaction's). The grid's actuals, its uncategorized
 * badge, the dashboard's review count and the drill-down behind a cell all use this one
 * predicate, so a cell and the list behind it always agree.
 */
export function onBudgetOrFeedCategory(categoryExpr: SQL): SQL {
  return sql`(${account.onBudget} = true or ${categoryExpr} = (select ${householdSetting.investmentIncomeCategoryId} from ${householdSetting} limit 1))`;
}
