import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PasskeyView, RevokeSessionsResponse, SessionView, SignInActivity, TotpSetupResponse, UserView } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { addPasskey, PASSKEY_NAME_MAX, passkeyErrorMessage, passkeyNameProblem, passkeysSupported } from "../../lib/passkeys.js";
import { showSignedOut, useAuthStatus } from "../../lib/auth.js";
import { relativeTime } from "../../lib/format.js";
import { describeDevice, failedSignInWarning, isFailedSignIn, MIN_PASSWORD_LENGTH, newMemberProblem, newPasswordProblem, passwordChangeProblem, signInEventLabel } from "../../lib/security.js";
import { Badge, Card, Empty, ErrorText } from "../ui.js";
import "./SecuritySettings.css";

const SESSIONS_KEY = ["auth", "sessions"] as const;
const ACTIVITY_KEY = ["auth", "activity"] as const;
const USERS_KEY = ["users"] as const;
const PASSKEYS_KEY = ["auth", "passkeys"] as const;

const when = (iso: string) => new Date(iso).toLocaleString();
const othersSignedOut = (n: number) => (n === 0 ? "" : n === 1 ? " 1 other session was signed out." : ` ${n} other sessions were signed out.`);

/**
 * Settings > Sign-in and security. Every member manages their own password, authenticator
 * and sessions; the owner also manages the household's members; the sign-in activity shows
 * the owner everyone's attempts and a viewer their own. The checks live in lib/security.ts.
 */
export function SecuritySettings() {
  const status = useAuthStatus();
  const owner = status.data?.role === "owner";
  return (
    <section className="settings-form security" aria-label="Sign-in and security">
      <h1 className="security-heading">Sign-in and security</h1>
      <PasswordCard />
      <AuthenticatorCard />
      <PasskeysCard />
      <SessionsCard />
      {owner && <MembersCard />}
      <ActivityCard owner={owner} />
    </section>
  );
}

function PasswordCard() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: () => api<RevokeSessionsResponse>("/auth/password", { method: "POST", body: { currentPassword: form.current, newPassword: form.next } }),
    onSuccess: () => {
      setForm({ current: "", next: "", confirm: "" });
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });
  const edit = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setProblem(null);
    change.reset();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = passwordChangeProblem(form);
    setProblem(p);
    if (!p) change.mutate();
  };
  return (
    <Card title="Password">
      <form className="settings-fields" onSubmit={submit}>
        <label>
          Current password
          <input type="password" value={form.current} onChange={(e) => edit({ current: e.target.value })} autoComplete="current-password" />
        </label>
        <label>
          New password <span className="muted">({MIN_PASSWORD_LENGTH}+ characters)</span>
          <input type="password" value={form.next} onChange={(e) => edit({ next: e.target.value })} autoComplete="new-password" />
        </label>
        <label>
          New password again
          <input type="password" value={form.confirm} onChange={(e) => edit({ confirm: e.target.value })} autoComplete="new-password" />
        </label>
        {problem && <p className="error">{problem}</p>}
        <ErrorText error={change.error} />
        <div className="row wrap">
          <button type="submit" disabled={change.isPending}>
            {change.isPending ? "Changing…" : "Change password"}
          </button>
          {change.data && <span className="notice">Password changed.{othersSignedOut(change.data.revoked)}</span>}
        </div>
        <span className="muted small">Changing it signs you out everywhere else; this browser stays signed in.</span>
      </form>
    </Card>
  );
}

function AuthenticatorCard() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const start = useMutation({ mutationFn: () => api<TotpSetupResponse>("/auth/totp/replace", { method: "POST", body: { password } }), onSuccess: () => setPassword("") });
  const confirm = useMutation({
    mutationFn: () => api<RevokeSessionsResponse>("/auth/totp/replace/confirm", { method: "POST", body: { code } }),
    onSuccess: () => {
      setOpen(false);
      setCode("");
      start.reset();
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });
  const cancel = () => {
    setOpen(false);
    setPassword("");
    setCode("");
    start.reset();
    confirm.reset();
  };
  return (
    <Card title="Authenticator app">
      <div className="settings-fields">
        <p className="muted small settings-note">
          Two-factor authentication is on. To move to a new phone or app, replace the authenticator here while you still have the old one: it keeps working until a code from the new one is accepted. If
          you have lost it, the owner can clear it for a viewer below; the owner's own is cleared on the server (see "Locked out" in the README).
        </p>
        {!open && (
          <div className="row wrap">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                confirm.reset();
                setOpen(true);
              }}
            >
              Replace authenticator
            </button>
            {confirm.data && <span className="notice">Authenticator replaced.{othersSignedOut(confirm.data.revoked)}</span>}
          </div>
        )}
        {open && !start.data && (
          <form
            className="settings-fields"
            onSubmit={(e) => {
              e.preventDefault();
              start.mutate();
            }}
          >
            <label>
              Your password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus required />
            </label>
            <ErrorText error={start.error} />
            <div className="row wrap">
              <button type="submit" disabled={start.isPending || password === ""}>
                Continue
              </button>
              <button type="button" className="secondary" onClick={cancel}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {open && start.data && (
          <form
            className="settings-fields"
            onSubmit={(e) => {
              e.preventDefault();
              confirm.mutate();
            }}
          >
            <img src={start.data.qrDataUrl} alt="QR code for the new authenticator" className="qr security-qr" />
            <details>
              <summary className="muted">Can't scan? Enter the key by hand</summary>
              <code className="secret">{start.data.secret}</code>
            </details>
            <label>
              Code from the new authenticator
              <input inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" className="settings-short" required />
            </label>
            <ErrorText error={confirm.error} />
            <div className="row wrap">
              <button type="submit" disabled={confirm.isPending || code.length !== 6}>
                Use the new authenticator
              </button>
              <button type="button" className="secondary" onClick={cancel}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

/**
 * Audit a10-conformance-ledger-09 (spec, Security: "optional passkeys"): passkeys sign this
 * member in with the device's screen lock, instead of the password and the code. Adding one
 * asks for the password; the password and the authenticator stay.
 */
function PasskeysCard() {
  const qc = useQueryClient();
  const [supported] = useState(passkeysSupported);
  const passkeys = useQuery({ queryKey: PASSKEYS_KEY, queryFn: () => api<PasskeyView[]>("/auth/passkeys") });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", password: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => addPasskey(form),
    onSuccess: () => {
      setOpen(false);
      setForm({ name: "", password: "" });
      void qc.invalidateQueries({ queryKey: PASSKEYS_KEY });
    },
  });
  const remove = useMutation({
    mutationFn: (p: PasskeyView) => api<{ ok: true }>(`/auth/passkeys/${p.id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: PASSKEYS_KEY }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = passkeyNameProblem(form.name);
    setProblem(p);
    if (!p) add.mutate();
  };
  const cancel = () => {
    setOpen(false);
    setForm({ name: "", password: "" });
    setProblem(null);
    add.reset();
  };
  const list = passkeys.data ?? [];
  return (
    <Card title="Passkeys">
      <div className="settings-fields">
        <p className="muted small settings-note">
          A passkey signs you in with this device&apos;s screen lock (fingerprint, face or PIN) instead of the password and the code. It works only at the address you add it on. Your password and
          authenticator stay; clearing the authenticator (a lost phone) removes the passkeys too.
        </p>
        <ErrorText error={passkeys.error} />
        <ErrorText error={remove.error} />
        {passkeys.data !== undefined && list.length === 0 && <p className="muted small">No passkeys yet.</p>}
        {list.length > 0 && (
          <ul className="list">
            {list.map((p) => (
              <li key={p.id} className="list-item">
                <div className="grow">
                  <strong>{p.name}</strong>{" "}
                  <span className="muted small">
                    · added {when(p.createdAt)} · {p.lastUsedAt ? `last used ${relativeTime(p.lastUsedAt)}` : "not used yet"}
                    {p.backedUp ? " · synced to your other devices" : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className="link danger small"
                  onClick={() => {
                    if (confirm(`Remove the passkey "${p.name}"? It will no longer sign you in.`)) remove.mutate(p);
                  }}
                  disabled={remove.isPending}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {!supported && <p className="muted small">This browser cannot use passkeys here (they need the app&apos;s https address, or localhost).</p>}
        {supported && !open && (
          <div className="row wrap">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                add.reset();
                setOpen(true);
              }}
            >
              Add a passkey
            </button>
          </div>
        )}
        {supported && open && (
          <form className="settings-fields" onSubmit={submit}>
            <label>
              Name <span className="muted">(the device or app that holds it)</span>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} maxLength={PASSKEY_NAME_MAX} placeholder="Phone" autoFocus />
            </label>
            <label>
              Your password
              <input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} autoComplete="current-password" required />
            </label>
            {problem && <p className="error">{problem}</p>}
            {add.error && <p className="error">{passkeyErrorMessage(add.error)}</p>}
            <div className="row wrap">
              <button type="submit" disabled={add.isPending || form.password === ""}>
                {add.isPending ? "Waiting for the passkey…" : "Continue"}
              </button>
              <button type="button" className="secondary" onClick={cancel}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

function SessionsCard() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: SESSIONS_KEY, queryFn: () => api<SessionView[]>("/auth/sessions") });
  const signOut = useMutation({
    mutationFn: (s: SessionView) => api<{ ok: true }>(`/auth/sessions/${s.id}`, { method: "DELETE" }),
    onSuccess: (_ok, s) => {
      if (s.current) {
        showSignedOut(qc); // this browser's own session: back to the sign-in screen with nothing cached
      } else {
        void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
      }
    },
  });
  const signOutOthers = useMutation({
    mutationFn: () => api<RevokeSessionsResponse>("/auth/sessions/revoke-others", { method: "POST", body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: SESSIONS_KEY }),
  });
  const list = sessions.data ?? [];
  return (
    <Card
      title="Where you are signed in"
      actions={
        list.length > 1 ? (
          <button type="button" className="secondary" onClick={() => signOutOthers.mutate()} disabled={signOutOthers.isPending}>
            Sign out everywhere else
          </button>
        ) : undefined
      }
    >
      <ErrorText error={sessions.error} />
      <ErrorText error={signOut.error} />
      <ErrorText error={signOutOthers.error} />
      {signOutOthers.data && <p className="notice">{signOutOthers.data.revoked === 1 ? "1 session signed out." : `${signOutOthers.data.revoked} sessions signed out.`}</p>}
      <div className="security-scroll">
        <table className="table small">
          <thead>
            <tr>
              <th>Device</th>
              <th>Address</th>
              <th>Signed in</th>
              <th>Last used</th>
              <th>Ends</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td title={s.userAgent ?? undefined}>
                  {describeDevice(s.userAgent)}
                  {s.current && <Badge tone="ok">this browser</Badge>}
                </td>
                <td>{s.ip ?? "—"}</td>
                <td>{when(s.createdAt)}</td>
                <td>{relativeTime(s.lastSeenAt)}</td>
                <td>{when(s.expiresAt)}</td>
                <td>
                  <button type="button" className="link danger small" onClick={() => signOut.mutate(s)} disabled={signOut.isPending}>
                    Sign out
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small settings-note">A session ends after a stretch without use or at its "Ends" time, whichever comes first.</p>
    </Card>
  );
}

function MembersCard() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: USERS_KEY, queryFn: () => api<UserView[]>("/users") });
  const [form, setForm] = useState({ username: "", password: "", confirm: "" });
  const [problem, setProblem] = useState<string | null>(null);
  /** The viewer whose password is being set, and the two fields for it. */
  const [setting, setSetting] = useState<{ id: string; password: string; confirm: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: USERS_KEY });
    void qc.invalidateQueries({ queryKey: ACTIVITY_KEY });
  };
  const add = useMutation({
    mutationFn: () => api<UserView>("/users", { method: "POST", body: { username: form.username.trim(), password: form.password } }),
    onSuccess: (u) => {
      setForm({ username: "", password: "", confirm: "" });
      setNotice(`${u.username} can now sign in with that password. They set up their own authenticator app at the first sign-in and can then change the password under Settings.`);
      refresh();
    },
  });
  const setPassword = useMutation({
    mutationFn: (v: { id: string; password: string }) => api<UserView>(`/users/${v.id}/password`, { method: "POST", body: { password: v.password } }),
    onSuccess: (u) => {
      setSetting(null);
      setNotice(`${u.username} has a new password and was signed out everywhere.`);
      refresh();
    },
  });
  const resetTotp = useMutation({
    mutationFn: (id: string) => api<UserView>(`/users/${id}/totp/reset`, { method: "POST", body: {} }),
    onSuccess: (u) => {
      setNotice(`${u.username}'s authenticator and passkeys are cleared and they were signed out. They set up a new one at the next sign-in; until then their password alone reaches that setup screen, so do it soon.`);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (u: UserView) => api<{ ok: true }>(`/users/${u.id}`, { method: "DELETE" }),
    onSuccess: (_ok, u) => {
      setNotice(`${u.username} was removed.`);
      refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = newMemberProblem(form);
    setProblem(p);
    setNotice(null);
    if (!p) add.mutate();
  };
  const settingProblem = setting ? newPasswordProblem(setting) : null;

  return (
    <Card title="Household members">
      <p className="muted small settings-note">
        The owner (you) can change everything. A viewer sees everything and changes nothing except their own password, authenticator and sessions.
      </p>
      <ErrorText error={users.error} />
      {notice && <p className="notice">{notice}</p>}
      <ErrorText error={setPassword.error} />
      <ErrorText error={resetTotp.error} />
      <ErrorText error={remove.error} />
      <div className="security-scroll">
        <table className="table small">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Two-factor</th>
              <th>Last sign-in</th>
              <th>Sessions</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(users.data ?? []).map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.role === "owner" ? "Owner" : "Viewer"}</td>
                <td>{u.totpEnrolled ? <Badge tone="ok">on</Badge> : <Badge tone="warn">set up at next sign-in</Badge>}</td>
                <td>{u.lastSignInAt ? when(u.lastSignInAt) : "never"}</td>
                <td>{u.activeSessions}</td>
                <td>
                  {u.role === "viewer" && (
                    <span className="row wrap">
                      <button type="button" className="link small" onClick={() => setSetting(setting?.id === u.id ? null : { id: u.id, password: "", confirm: "" })}>
                        Set password
                      </button>
                      <button
                        type="button"
                        className="link small"
                        disabled={!u.totpEnrolled || resetTotp.isPending}
                        onClick={() => {
                          if (window.confirm(`Clear ${u.username}'s authenticator and passkeys? They are signed out and set up a new authenticator at their next sign-in.`)) resetTotp.mutate(u.id);
                        }}
                      >
                        Reset two-factor
                      </button>
                      <button
                        type="button"
                        className="link danger small"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(`Remove ${u.username}? They are signed out and can no longer sign in.`)) remove.mutate(u);
                        }}
                      >
                        Remove
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {setting && (
        <form
          className="settings-fields security-inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (!settingProblem) setPassword.mutate({ id: setting.id, password: setting.password });
          }}
        >
          <strong>New password for {users.data?.find((u) => u.id === setting.id)?.username}</strong>
          <label>
            Password <span className="muted">({MIN_PASSWORD_LENGTH}+ characters)</span>
            <input type="password" value={setting.password} onChange={(e) => setSetting({ ...setting, password: e.target.value })} autoComplete="new-password" autoFocus />
          </label>
          <label>
            Password again
            <input type="password" value={setting.confirm} onChange={(e) => setSetting({ ...setting, confirm: e.target.value })} autoComplete="new-password" />
          </label>
          {setting.password !== "" && setting.confirm !== "" && settingProblem && <p className="error">{settingProblem}</p>}
          <div className="row wrap">
            <button type="submit" disabled={settingProblem !== null || setPassword.isPending}>
              Set password and sign them out
            </button>
            <button type="button" className="secondary" onClick={() => setSetting(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <form className="settings-fields security-inline" onSubmit={submit}>
        <strong>Add a viewer</strong>
        <label>
          Username
          <input
            value={form.username}
            onChange={(e) => {
              setForm({ ...form, username: e.target.value });
              setProblem(null);
            }}
            autoComplete="off"
            maxLength={64}
          />
        </label>
        <label>
          First password <span className="muted">({MIN_PASSWORD_LENGTH}+ characters; tell it to them in person)</span>
          <input
            type="password"
            value={form.password}
            onChange={(e) => {
              setForm({ ...form, password: e.target.value });
              setProblem(null);
            }}
            autoComplete="new-password"
          />
        </label>
        <label>
          First password again
          <input
            type="password"
            value={form.confirm}
            onChange={(e) => {
              setForm({ ...form, confirm: e.target.value });
              setProblem(null);
            }}
            autoComplete="new-password"
          />
        </label>
        {problem && <p className="error">{problem}</p>}
        <ErrorText error={add.error} />
        <div className="row wrap">
          <button type="submit" disabled={add.isPending}>
            {add.isPending ? "Adding…" : "Add viewer"}
          </button>
        </div>
      </form>
    </Card>
  );
}

function ActivityCard({ owner }: { owner: boolean }) {
  const activity = useQuery({ queryKey: ACTIVITY_KEY, queryFn: () => api<SignInActivity>("/auth/activity") });
  const items = activity.data?.items ?? [];
  const warning = activity.data ? failedSignInWarning(activity.data.failedLast7Days) : null;
  return (
    <Card title="Sign-in activity">
      <ErrorText error={activity.error} />
      {warning && <p className="security-warning">{warning}</p>}
      {activity.data && items.length === 0 && <Empty>No sign-ins recorded yet.</Empty>}
      {items.length > 0 && (
        <div className="security-scroll">
          <table className="table small">
            <thead>
              <tr>
                <th>When</th>
                {owner && <th>Account</th>}
                <th>What</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td>{when(e.at)}</td>
                  {owner && <td>{e.username}</td>}
                  <td className={isFailedSignIn(e.kind) ? "security-failed" : undefined}>{signInEventLabel(e.kind)}</td>
                  <td title={e.userAgent ?? undefined}>
                    {e.ip ?? "—"} · {describeDevice(e.userAgent)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small settings-note">
        {owner ? "Every member's" : "Your"} completed sign-ins and failed attempts, newest first, kept for 90 days. After five wrong authenticator codes a sign-in is stopped and codes are refused for a few
        minutes.
      </p>
    </Card>
  );
}
