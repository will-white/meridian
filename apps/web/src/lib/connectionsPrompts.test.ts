import { describe, expect, it } from "vitest";
import { deleteProfilePrompt, removeConnectionPrompt } from "./connections.js";

/** Audit a10-conformance-ledger-04: the confirmations say what a removal keeps. */
describe("removal prompts (audit a10-conformance-ledger-04)", () => {
  it("removing a connection keeps its accounts, transactions and stored responses", () => {
    const text = removeConnectionPrompt("First Example Bank");
    expect(text).toContain("Remove First Example Bank?");
    expect(text).toContain("the stored bank responses stay");
    expect(text).toContain("the access URL is deleted");
    expect(text).toContain("attaches the same accounts and their stored responses");
  });

  it("deleting a mapping profile keeps its imports, which can still be undone", () => {
    const text = deleteProfilePrompt("First Bank");
    expect(text).toContain('Delete the mapping "First Bank"?');
    expect(text).toContain("the imports made with it, and their rows, stay");
    expect(text).toContain("can still be undone");
  });
});
