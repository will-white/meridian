/**
 * The result mappers (strategies-outputs-web §3.9 to §3.11): the aggregated run to the stored
 * `SimSummary` and `FanSeries`, and one path's detail to its `YearTable`.
 */

export { failureSummary, toFanSeries, toSimSummary } from "./summary.js";
export { essentialCoverageBp, portfolioReturnBp, toYearTable, withdrawalRateBp } from "./yearTable.js";
