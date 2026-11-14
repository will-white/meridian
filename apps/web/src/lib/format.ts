import { formatCents } from "@meridian/shared";

/** "-1234567" cents -> "-$12,345.67". String math only; no floats touch money. */
export function money(cents: string | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined) return "—";
  const plain = formatCents(BigInt(cents));
  const negative = plain.startsWith("-");
  const [whole, frac] = (negative ? plain.slice(1) : plain).split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${negative ? "-" : ""}${symbol}${grouped}.${frac}`;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "11/13/26". A calendar date (YYYY-MM-DD: a posting date, a due date, the `today` the app sends)
 * is shown as written. A timestamp (an alert's or a reconciliation's createdAt, a price run's
 * runAt) is shown as the browser's local calendar date, the day the dashboard calls today
 * (phase 2 decisions 16 and A22): 2026-11-14T00:10Z is 11/13/26 on a Denver evening, not the
 * UTC day (audit b8-web-layout-03).
 */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  if (CALENDAR_DATE.test(iso)) return `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(2, 4)}`;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getMonth() + 1)}/${pad(at.getDate())}/${String(at.getFullYear()).slice(-2)}`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/**
 * Text for a place that sets HTML (an ECharts tooltip formatter returns HTML): every character
 * that could open markup or an attribute is escaped. Account, payee and security names come
 * from the feed and from imports, so they are text, never markup (audit a6-text-rules-accounts-01).
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}
