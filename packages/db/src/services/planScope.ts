import { sql, type SQL } from "drizzle-orm";
import { account, householdSetting } from "../schema/index.js";

/**
 * What the spending plan reads (Phase 3, plan decision 15): rows of on-budget accounts, plus
 * rows in the household's investment income category (the feed) from any account. The query
 * must join `account` on the transaction's account. `categoryExpr` is the row's effective
 * category (a split line's, else the transaction's). The grid's actuals, its uncategorized
 * badge, the dashboard's review count and the drill-down behind a cell all use this one
 * predicate, line by line, so a cell and the list behind it always agree. A goal's transfer
 * legs in its linked account are not under it: the goal's cell and its list count them
 * whatever the account's budget flag (`loadGoalNets`, `listTransactions`).
 */
export function onBudgetOrFeedCategory(categoryExpr: SQL): SQL {
  return sql`(${account.onBudget} = true or ${categoryExpr} = (select ${householdSetting.investmentIncomeCategoryId} from ${householdSetting} limit 1))`;
}
