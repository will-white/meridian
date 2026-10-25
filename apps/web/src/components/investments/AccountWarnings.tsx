import type { AccountWarningView } from "@meridian/shared";

/**
 * The yellow strip under a view: the server's readable warnings (one per
 * line) and the per-account warnings prefixed with the account's name
 * ("Fidelity Roth IRA: Positions are 41 days old; import a statement").
 */
export function AccountWarnings({ warnings = [], accountWarnings = [] }: { warnings?: readonly string[]; accountWarnings?: readonly AccountWarningView[] }) {
  if (warnings.length === 0 && accountWarnings.length === 0) return null;
  return (
    <ul className="inv-warnings" aria-label="Warnings">
      {warnings.map((w) => (
        <li key={w}>{w}</li>
      ))}
      {accountWarnings.map((w, i) => (
        <li key={`${w.accountId}-${w.kind}-${i}`}>
          <strong>{w.accountName}:</strong> {w.message}
        </li>
      ))}
    </ul>
  );
}
