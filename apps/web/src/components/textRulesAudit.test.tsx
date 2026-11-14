import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { AuditList, AuthStatus, CategoryView, RuleView } from "@meridian/shared";
import { AUTH_KEY } from "../lib/auth.js";
import { RulesPage } from "../pages/RulesPage.js";

/**
 * Audit batch a6-text-rules-accounts, second round: what the Rules page says about a stored rule
 * that does not run as written, as static markup (the suite has no browser engine; the page was
 * also checked in the built app in headless Chromium). The record is
 * docs/audit/phases-1-3/a6-text-rules-accounts.md.
 */

const OWNER: AuthStatus = { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: "owner", role: "owner" };
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CATEGORIES: CategoryView[] = [{ id: U(301), name: "Hardware", bucket: "spending", hidden: false }];

function render(ui: ReactElement, qc: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/rules"]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const rule = (over: Partial<RuleView> = {}): RuleView => ({
  id: U(500),
  name: "Ace → Hardware",
  position: 1,
  enabled: true,
  conditions: { payee: { op: "contains", value: "ace hardware" } },
  actions: { setCategoryId: U(301) },
  createdAt: "2026-11-01T00:00:00Z",
  problems: [],
  ...over,
});

describe("Rules page and a stored rule that cannot run as written (a6-text-rules-accounts, second round)", () => {
  it("shows the server's reason beside the rule, and nothing beside a rule that runs", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, retryOnMount: false } } });
    qc.setQueryData(AUTH_KEY, OWNER);
    qc.setQueryData(["categories"], CATEGORIES);
    qc.setQueryData(["accounts"], []);
    qc.setQueryData(["audit", "rule", null], { items: [], nextCursor: null } satisfies AuditList);
    const reason = "The description pattern cannot run here (invalid or unsupported Perl syntax: `(?!`), so this rule never matches. Edit it: look-ahead, look-behind and back-references are not supported.";
    qc.setQueryData(["rules"], [
      rule(),
      rule({ id: U(501), name: "Ace, not refunds", position: 2, conditions: { description: { op: "regex", value: "^(?!.*REFUND).*ACE" } }, problems: [reason] }),
    ]);
    const html = render(<RulesPage />, qc);
    const page = text(html);
    expect(page).toContain(`Ace, not refunds needs an edit description matches pattern "^(?!.*REFUND).*ACE" ${reason}`);
    expect(page.match(/needs an edit/g)).toHaveLength(1);
    expect(html.match(/role="note"/g)).toHaveLength(1);
    expect(page).toContain("Ace → Hardware payee contains \"ace hardware\" category → Hardware");
  });
});
