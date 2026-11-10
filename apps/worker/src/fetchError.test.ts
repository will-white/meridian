import { describe, expect, it } from "vitest";
import { describeFetchFailure } from "./fetchError.js";

/** The error Node's fetch throws for any transport failure: `TypeError: fetch failed`, with the reason in `cause`. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause });
}
const withCode = (message: string, code: string): Error => Object.assign(new Error(message), { code });

describe("describeFetchFailure", () => {
  it("names a certificate the system does not trust, so it does not read as an outage", () => {
    expect(describeFetchFailure(fetchFailed(withCode("self-signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT")))).toBe(
      "its certificate was not accepted: self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)",
    );
    expect(describeFetchFailure(fetchFailed(withCode("certificate has expired", "CERT_HAS_EXPIRED")))).toBe("its certificate was not accepted: certificate has expired (CERT_HAS_EXPIRED)");
    expect(describeFetchFailure(fetchFailed(withCode("Hostname/IP does not match certificate's altnames: Host: bridge.example.test. is not in the cert's altnames", "ERR_TLS_CERT_ALTNAME_INVALID")))).toMatch(
      /^its certificate was not accepted: Hostname\/IP does not match .* \(ERR_TLS_CERT_ALTNAME_INVALID\)$/,
    );
  });

  it("carries the cause of a connection that could not be made, without repeating its code", () => {
    expect(describeFetchFailure(fetchFailed(withCode("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED")))).toBe("connect ECONNREFUSED 127.0.0.1:443");
    expect(describeFetchFailure(fetchFailed(withCode("getaddrinfo ENOTFOUND bridge.example.test", "ENOTFOUND")))).toBe("getaddrinfo ENOTFOUND bridge.example.test");
    expect(describeFetchFailure(fetchFailed(new Error("unexpected redirect")))).toBe("unexpected redirect");
    expect(describeFetchFailure(fetchFailed(withCode("other side closed", "UND_ERR_SOCKET")))).toBe("other side closed (UND_ERR_SOCKET)");
    // OpenSSL's own line (here: TLS spoken to a port that answers in plain HTTP) is cut down to its reason.
    const openssl = withCode("C0BC0848987F0000:error:0A0000C6:SSL routines:tls_get_more_records:packet length too long:../deps/openssl/openssl/ssl/record/methods/tls_common.c:662:\n", "ERR_SSL_PACKET_LENGTH_TOO_LONG");
    expect(describeFetchFailure(fetchFailed(openssl))).toBe("packet length too long (ERR_SSL_PACKET_LENGTH_TOO_LONG)");
    // Several addresses were tried (IPv6, then IPv4): the first reason stands for them.
    const tried = Object.assign(new AggregateError([withCode("connect ECONNREFUSED ::1:443", "ECONNREFUSED"), withCode("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED")], ""), { code: "ECONNREFUSED" });
    expect(describeFetchFailure(fetchFailed(tried))).toBe("connect ECONNREFUSED ::1:443");
  });

  it("says how long it waited when the request timed out", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(describeFetchFailure(timeout, { timeoutMs: 60_000 })).toBe("timeout (no answer within 60 seconds)");
    expect(describeFetchFailure(timeout)).toBe("timeout (no answer in time)");
  });

  it("falls back to the error's own message, and never repeats a URL's credentials, path or query", () => {
    expect(describeFetchFailure(new Error("ECONNRESET"))).toBe("ECONNRESET");
    expect(describeFetchFailure(new TypeError("fetch failed"))).toBe("fetch failed");
    expect(describeFetchFailure("boom")).toBe("boom");
    expect(describeFetchFailure(fetchFailed(new Error("cannot connect to https://alice:s3cret@bridge.example.test/simplefin/claim/TOKEN123?x=1 right now")))).toBe(
      "cannot connect to https://bridge.example.test right now",
    );
    // One line, bounded: OpenSSL's reasons come with a source location and a newline.
    const long = describeFetchFailure(fetchFailed(withCode(`${"x".repeat(400)}\nsecond line`, "ERR_SSL_SOMETHING")));
    expect(long).not.toContain("second line");
    expect(long.length).toBeLessThanOrEqual(240);
  });
});
