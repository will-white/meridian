import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AuthStatus, TotpSetupResponse } from "@meridian/shared";
import { api } from "../lib/api.js";
import { AUTH_KEY, noteSignedOut, useAuthMutation, useLogout, useSignInNotice } from "../lib/auth.js";
import { useDocumentTitle } from "../lib/useDocumentTitle.js";
import { ErrorText } from "../components/ui.js";

/** A signed-out screen: the page's main landmark and its document title (audit b8-web-layout-14). */
function AuthFrame({ title, children }: { title: string; children: React.ReactNode }) {
  useDocumentTitle(`${title} · Meridian`);
  return (
    <main className="auth-frame">
      <div className="auth-card">
        <div className="brand big">Meridian</div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function SetupPage() {
  const setup = useAuthMutation<{ username: string; password: string }>("/auth/setup");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && confirm !== password;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setup.mutate({ username, password });
  };
  return (
    <AuthFrame title="Create the owner account">
      <p className="muted">
        This is a single-household app. One owner, protected by a password and an authenticator app; the owner can add read-only viewers later under Settings.
      </p>
      <form onSubmit={submit} className="stack">
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password <span className="muted">(12+ characters)</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={12} required />
        </label>
        <label>
          Confirm password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </label>
        {mismatch && <p className="error">Passwords do not match</p>}
        <ErrorText error={setup.error} />
        <button type="submit" disabled={setup.isPending || mismatch}>
          Create account
        </button>
      </form>
    </AuthFrame>
  );
}

export function LoginPage() {
  const login = useAuthMutation<{ username: string; password: string }>("/auth/login");
  const notice = useSignInNotice();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  return (
    <AuthFrame title="Sign in">
      {notice && !login.error && <p className="error">{notice}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate({ username, password });
        }}
        className="stack"
      >
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <ErrorText error={login.error} />
        <button type="submit" disabled={login.isPending}>
          Continue
        </button>
      </form>
    </AuthFrame>
  );
}

export function TotpVerifyPage({ status }: { status: AuthStatus }) {
  const verify = useAuthMutation<{ code: string }>("/auth/totp/verify");
  const logout = useLogout();
  const [code, setCode] = useState("");
  return (
    <AuthFrame title="Authenticator code">
      <p className="muted">Password accepted for {status.username}. Enter the 6-digit code from your authenticator app within ten minutes; each code works once.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          verify.mutate({ code });
        }}
        className="stack"
      >
        <input inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus required />
        <ErrorText error={verify.error} />
        <button type="submit" disabled={verify.isPending || code.length !== 6}>
          Verify
        </button>
        <button type="button" className="link" onClick={() => logout.mutate()}>
          Use a different account
        </button>
      </form>
    </AuthFrame>
  );
}

export function TotpEnrollPage({ status }: { status: AuthStatus }) {
  const qc = useQueryClient();
  const start = useMutation({ mutationFn: () => api<TotpSetupResponse>("/auth/totp/setup", { method: "POST", body: {} }), onError: (error) => noteSignedOut(qc, error) });
  const confirm = useMutation({
    mutationFn: (code: string) => api<AuthStatus>("/auth/totp/confirm", { method: "POST", body: { code } }),
    onSuccess: (s) => {
      qc.setQueryData(AUTH_KEY, s);
      void qc.invalidateQueries();
    },
    onError: (error) => noteSignedOut(qc, error),
  });
  const logout = useLogout();
  const [code, setCode] = useState("");
  return (
    <AuthFrame title="Set up two-factor authentication">
      <p className="muted">
        Welcome, {status.username}. Two-factor authentication is required: scan the code with an authenticator app (Aegis, 1Password, Google Authenticator), then
        enter the 6-digit code it shows. You have ten minutes; after that, sign in again and pick up here.
      </p>
      {!start.data ? (
        <div className="stack">
          <ErrorText error={start.error} />
          <button onClick={() => start.mutate()} disabled={start.isPending}>
            Show QR code
          </button>
          <button type="button" className="link" onClick={() => logout.mutate()}>
            Sign out
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate(code);
          }}
          className="stack"
        >
          <img src={start.data.qrDataUrl} alt="TOTP QR code" className="qr" />
          <details>
            <summary className="muted">Can't scan? Enter the key by hand</summary>
            <code className="secret">{start.data.secret}</code>
          </details>
          <input inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" required />
          <ErrorText error={confirm.error} />
          <button type="submit" disabled={confirm.isPending || code.length !== 6}>
            Activate
          </button>
        </form>
      )}
    </AuthFrame>
  );
}
