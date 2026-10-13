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

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${m}/${d}/${y!.slice(2)}`;
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
