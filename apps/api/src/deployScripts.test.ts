import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";

/**
 * deploy/backup.sh, restore.sh and restore-check.sh against a real Postgres (audit
 * a7-backup-deploy-secrets 01 to 05, 08, 12, 14, 18). The scripts run under the local /bin/sh
 * with the same tools the backup image has (pg_dump, psql, gzip, openssl); a tool is "missing"
 * by running the script with a PATH that leaves it out.
 */
const deploy = (name: string) => fileURLToPath(new URL(`../../../deploy/${name}`, import.meta.url));
const BACKUP = deploy("backup.sh");
const RESTORE = deploy("restore.sh");
const RESTORE_CHECK = deploy("restore-check.sh");
const TOOLS = ["pg_dump", "psql", "openssl", "gzip", "tail", "tr", "grep", "sort", "awk", "ls", "cut", "date", "mkdir", "chmod", "mv", "rm", "cp", "du", "basename", "touch", "cat", "sed", "id", "head", "dirname", "chown", "mktemp", "sh", "printf"];
const which = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
const haveTools = ["pg_dump", "psql", "openssl", "gzip"].every((tool) => which(tool).startsWith("/"));
const PASSPHRASE = "correct horse battery staple";
const MARKER = "-- PostgreSQL database dump complete";

describe.skipIf(!TEST_DATABASE_URL || !haveTools)("deploy scripts: backup, restore and the restore check", () => {
  let source: TestDb;
  let admin: postgres.Sql;
  let scratch: string;
  let pg: { host: string; port: string; user: string; password: string };
  const others: TestDb[] = [];
  /** Another migrated database with the one owner; dropped (with any copies a restore left beside it) after the suite. */
  const liveDb = async () => {
    const db = await createTestDb();
    await db.client.unsafe(`insert into "user" (username, password_hash, role) values ('owner', 'x', 'owner')`);
    await db.client.end();
    others.push(db);
    return db.databaseName;
  };

  beforeAll(async () => {
    source = await createTestDb();
    await source.client.unsafe(`insert into "user" (username, password_hash, role) values ('owner', 'x', 'owner')`);
    admin = postgres(TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    const url = new URL(TEST_DATABASE_URL!);
    pg = { host: url.hostname, port: url.port || "5432", user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    scratch = mkdtempSync(path.join(tmpdir(), "meridian-deploy-scripts-"));
  });

  afterAll(async () => {
    // Every database these tests made starts with the source's name (or the restore-check prefix under it).
    for (const name of [source.databaseName, ...others.map((db) => db.databaseName)]) {
      const leftovers = await admin<{ datname: string }[]>`select datname from pg_database where datname like ${`${name}%`} and datname <> ${source.databaseName}`;
      for (const { datname } of leftovers) await admin.unsafe(`drop database if exists "${datname}" with (force)`);
    }
    await admin.end();
    await source.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  let dirs = 0;
  const newDir = (label: string) => {
    const dir = path.join(scratch, `${label}-${++dirs}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  /** A directory of links to every tool the scripts use, except `leaveOut`, plus any fake ones. */
  const pathWith = (leaveOut: string[], fakes: Record<string, string> = {}) => {
    const bin = newDir("bin");
    for (const tool of TOOLS) {
      const real = which(tool);
      if (!leaveOut.includes(tool) && real.startsWith("/")) symlinkSync(real, path.join(bin, tool));
    }
    for (const [name, body] of Object.entries(fakes)) {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    }
    return bin;
  };
  const baseEnv = (root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: process.env["PATH"],
    HOME: scratch,
    BACKUP_ROOT: root,
    BACKUP_PASSPHRASE: PASSPHRASE,
    POSTGRES_USER: pg.user,
    POSTGRES_PASSWORD: pg.password,
    POSTGRES_DB: source.databaseName,
    PGHOST: pg.host,
    PGPORT: pg.port,
    MERIDIAN_ENV_FILE: path.join(scratch, "no-such.env"),
    RESTORE_CHECK_PREFIX: `${source.databaseName}_rc_`,
    ...extra,
  });
  const run = (script: string, args: string[], env: NodeJS.ProcessEnv, cwd = scratch): SpawnSyncReturns<string> =>
    spawnSync("sh", [script, ...args], { env, cwd, encoding: "utf8", timeout: 60_000, input: "" });
  const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
  const decrypt = (file: string) =>
    spawnSync("sh", ["-c", `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:P -in "$1" | gzip -dc`, "sh", file], { env: { ...process.env, P: PASSPHRASE }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const encrypt = (text: string, out: string) =>
    spawnSync("sh", ["-c", `gzip -9 | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:P -out "$1"`, "sh", out], { env: { ...process.env, P: PASSPHRASE }, input: text });
  const userCount = async (database: string) => {
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${database}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      return Number((await sql<{ n: string }[]>`select count(*)::text as n from "user"`)[0]!.n);
    } finally {
      await sql.end();
    }
  };
  /** A verified backup of the source, made by the script itself. */
  const goodBackup = () => {
    const root = newDir("good");
    const result = run(BACKUP, [], baseEnv(root));
    expect(result.status, result.stderr).toBe(0);
    const [name] = files(path.join(root, "daily"));
    return { root, file: path.join(root, "daily", name!) };
  };
  /** A fake `sleep` that returns at once and stops the nightly loop at its `stopAt`-th call. */
  const fakeSleep = (counter: string, stopAt: number) =>
    `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${counter}"; [ "$n" -ge ${stopAt} ] && kill -TERM $PPID; exit 0`;

  it("a7-backup-deploy-secrets-01: without openssl a backup fails loudly and writes nothing, once or nightly", () => {
    const root = newDir("no-openssl");
    const bin = pathWith(["openssl"], { sleep: fakeSleep(path.join(root, "sleeps"), 2) });
    const once = run(BACKUP, [], baseEnv(root, { PATH: bin }));
    expect(once.status).not.toBe(0);
    expect(once.stderr).toContain("missing tools: openssl");
    expect(once.stdout).not.toContain("wrote");
    expect(once.stdout).not.toContain("promoted");

    // The nightly loop refuses to start, so the container restarts and shows it, instead of
    // reporting every night as a success.
    const nightly = run(BACKUP, ["--nightly"], baseEnv(root, { PATH: bin }));
    expect(nightly.status).not.toBe(0);
    expect(nightly.stderr).toContain("missing tools: openssl");
    expect(nightly.stdout).not.toContain("promoted");
    expect(files(path.join(root, "daily"))).toEqual([]);
    expect(files(path.join(root, "monthly"))).toEqual([]);
    expect(readFileSync(path.join(root, "status", "last-failure"), "utf8")).toContain("missing tools: openssl");
    expect(run(BACKUP, ["--health"], baseEnv(root)).status).toBe(1);
  });

  it("a7-backup-deploy-secrets-01: in nightly mode a failed backup is reported as FAILED and the loop goes on", () => {
    const root = newDir("nightly-fail");
    const bin = pathWith([], { sleep: fakeSleep(path.join(root, "sleeps"), 3) });
    const result = run(BACKUP, ["--nightly"], baseEnv(root, { PATH: bin, POSTGRES_DB: `${source.databaseName}_missing` }));
    // Two nights ran (the third sleep stopped the loop), and each one failed out loud.
    expect(result.stderr.match(/FAILED: the dump did not complete/g)?.length).toBe(2);
    expect(result.stdout).not.toContain("wrote");
    expect(result.stdout).not.toContain("promoted");
    expect(files(path.join(root, "daily"))).toEqual([]);
    expect(files(path.join(root, "monthly"))).toEqual([]);
    const health = run(BACKUP, ["--health"], baseEnv(root));
    expect(health.status).toBe(1);
    expect(health.stdout).toContain("the last backup failed");
  });

  it("a7-backup-deploy-secrets-02: a failing pg_dump writes nothing, keeps every good copy and promotes nothing", () => {
    const good = goodBackup();
    const root = newDir("failing-dump");
    mkdirSync(path.join(root, "daily"));
    mkdirSync(path.join(root, "monthly"));
    const seeded = Array.from({ length: 30 }, (_, i) => `meridian-202610${String(i + 1).padStart(2, "0")}T020000Z.sql.gz.enc`);
    for (const name of seeded) copyFileSync(good.file, path.join(root, "daily", name));
    const goodBytes = statSync(good.file).size;

    for (const [label, extra] of [
      ["wrong password", { POSTGRES_PASSWORD: "wrong" }],
      ["no such database", { POSTGRES_DB: `${source.databaseName}_missing` }],
      ["server down", { PGPORT: "1" }],
    ] as const) {
      const result = run(BACKUP, [], baseEnv(root, extra));
      expect(result.status, label).toBe(1);
      expect(result.stderr, label).toContain("FAILED: the dump did not complete: pg_dump exited");
      expect(result.stdout, label).not.toContain("wrote");
      expect(files(path.join(root, "daily")), label).toEqual(seeded);
      expect(files(path.join(root, "monthly")), label).toEqual([]);
    }
    for (const name of seeded) expect(statSync(path.join(root, "daily", name)).size).toBe(goodBytes);
  });

  it("a7-backup-deploy-secrets-02: a good backup is verified, promoted once a month and pruned beyond 30", () => {
    const { root, file } = goodBackup();
    const dump = decrypt(file);
    expect(dump.status).toBe(0);
    expect(dump.stdout).toContain(MARKER);
    expect(files(path.join(root, "monthly"))).toEqual([path.basename(file)]);
    expect(readFileSync(path.join(root, "status", "last-success"), "utf8")).toContain(path.basename(file));
    const health = run(BACKUP, ["--health"], baseEnv(root));
    expect(health.status, health.stdout).toBe(0);

    // 30 older dailies plus the new one: the oldest goes. This month's monthly is not replaced.
    for (let i = 1; i <= 30; i++) copyFileSync(file, path.join(root, "daily", `meridian-202609${String(i).padStart(2, "0")}T020000Z.sql.gz.enc`));
    const again = run(BACKUP, [], baseEnv(root));
    expect(again.status, again.stderr).toBe(0);
    const daily = files(path.join(root, "daily"));
    expect(daily).toHaveLength(30);
    expect(daily).not.toContain("meridian-20260901T020000Z.sql.gz.enc");
    expect(again.stdout).toContain("pruned");
    expect(again.stdout).not.toContain("promoted");
    expect(files(path.join(root, "monthly"))).toEqual([path.basename(file)]);
  });

  it("a7-backup-deploy-secrets-14: backup files and directories are readable by their owner only", () => {
    const { root, file } = goodBackup();
    for (const dir of [root, path.join(root, "daily"), path.join(root, "monthly"), path.join(root, "status")]) {
      expect((statSync(dir).mode & 0o777).toString(8), dir).toBe("700");
    }
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect((statSync(path.join(root, "monthly", path.basename(file))).mode & 0o777).toString(8)).toBe("600");
  });

  it("a7-backup-deploy-secrets-05: a failed off-site copy fails the run and the healthcheck, and is retried with the monthly copy", () => {
    const root = newDir("offsite");
    const failing = run(BACKUP, [], baseEnv(root, { BACKUP_COPY_CMD: 'echo "remote: unreachable" >&2; exit 1' }));
    expect(failing.status).toBe(3);
    expect(failing.stderr).toContain("off-site copy of daily/");
    expect(failing.stderr).toContain("FAILED");
    expect(readFileSync(path.join(root, "status", "offsite"), "utf8")).toContain("failed");
    const unhealthy = run(BACKUP, ["--health"], baseEnv(root));
    expect(unhealthy.status).toBe(1);
    expect(unhealthy.stdout).toContain("off-site copy is failing");

    const remote = newDir("remote");
    const copyCmd = `mkdir -p "${remote}/$2" && cp "$1" "${remote}/$2/"`;
    const working = run(BACKUP, [], baseEnv(root, { BACKUP_COPY_CMD: copyCmd }));
    expect(working.status, working.stderr).toBe(0);
    // Both nights' dailies (the first one's copy had failed) and the month's promotion are off the server.
    expect(files(path.join(remote, "daily"))).toEqual(files(path.join(root, "daily")));
    expect(files(path.join(remote, "daily"))).toHaveLength(2);
    expect(files(path.join(remote, "monthly"))).toEqual(files(path.join(root, "monthly")));
    expect(run(BACKUP, ["--health"], baseEnv(root)).status).toBe(0);
    // Nothing is copied twice. (Backups are named to the second; one made in the same second waits for the next.)
    const third = run(BACKUP, [], baseEnv(root, { BACKUP_COPY_CMD: copyCmd }));
    expect(third.stdout.match(/copied /g)?.length).toBe(1);
  });

  it("a7-backup-deploy-secrets-18: the healthcheck fails 26 hours after the last verified backup", () => {
    const { root } = goodBackup();
    const hours = (h: number) => Math.floor(Date.now() / 1000) - h * 3600;
    writeFileSync(path.join(root, "status", "last-success"), `${hours(25)} meridian-x.sql.gz.enc\n`);
    expect(run(BACKUP, ["--health"], baseEnv(root)).status).toBe(0);
    writeFileSync(path.join(root, "status", "last-success"), `${hours(27)} meridian-x.sql.gz.enc\n`);
    const stale = run(BACKUP, ["--health"], baseEnv(root));
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain("no verified backup for over 26 hours");
    // A container that has just started (no backup yet) is healthy until its first night has passed.
    const fresh = newDir("fresh");
    mkdirSync(path.join(fresh, "status"), { recursive: true });
    writeFileSync(path.join(fresh, "status", "started"), `${hours(1)} nightly mode\n`);
    expect(run(BACKUP, ["--health"], baseEnv(fresh)).status).toBe(0);
    writeFileSync(path.join(fresh, "status", "started"), `${hours(30)} nightly mode\n`);
    expect(run(BACKUP, ["--health"], baseEnv(fresh)).stdout).toContain("no verified backup yet");
  });

  it.skipIf(process.getuid?.() !== 0)("a7-backup-deploy-secrets-12: started as root, the backup hands its directory to BACKUP_RUN_AS and drops to it", () => {
    const root = newDir("drop");
    const calls = path.join(root, "..", `su-exec-calls-${dirs}`);
    const bin = pathWith([], { "su-exec": `echo "$@" >> "${calls}"; exit 0` });
    const result = run(BACKUP, [], baseEnv(root, { PATH: bin, BACKUP_RUN_AS: "nobody" }));
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(calls, "utf8").trim()).toBe(`nobody /bin/sh ${BACKUP}`);
    const nobody = Number(spawnSync("id", ["-u", "nobody"], { encoding: "utf8" }).stdout.trim());
    expect(statSync(root).uid).toBe(nobody);
    expect((statSync(root).mode & 0o777).toString(8)).toBe("700");
  });

  it("a7-backup-deploy-secrets-03: a wrong passphrase, a cut-short file or an empty dump leaves the database as it was", async () => {
    const { file } = goodBackup();
    const live = await liveDb();
    const cut = path.join(newDir("cut"), "cut.sql.gz.enc");
    writeFileSync(cut, readFileSync(file).subarray(0, Math.floor(statSync(file).size / 2)));
    const empty = path.join(newDir("empty"), "empty.sql.gz.enc");
    expect(encrypt("", empty).status).toBe(0);

    for (const [label, backup, extra] of [
      ["wrong passphrase", file, { BACKUP_PASSPHRASE: "wrong passphrase" }],
      ["cut short", cut, {}],
      ["empty dump", empty, {}],
    ] as const) {
      const result = run(RESTORE, ["--yes", backup], baseEnv(newDir("r"), { POSTGRES_DB: live, ...extra }));
      expect(result.status, label).toBe(1);
      expect(result.stderr, label).toContain("nothing was changed");
      expect(result.stdout, label).not.toContain("Restore complete");
      expect(await userCount(live), label).toBe(1);
    }
    const left = await admin<{ datname: string }[]>`select datname from pg_database where datname like ${`${live}_%`}`;
    expect(left).toEqual([]);
  });

  it("a7-backup-deploy-secrets-03: a restore replaces the database only after it completed, and keeps the one it replaced", async () => {
    const { file } = goodBackup();
    const live = await liveDb();
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${live}`;
    const liveSql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await liveSql.unsafe(`insert into "user" (username, password_hash, role) values ('viewer', 'x', 'viewer')`);
    await liveSql.end();

    // Without a terminal, replacing needs --yes.
    const unconfirmed = run(RESTORE, [file], baseEnv(newDir("r"), { POSTGRES_DB: live }));
    expect(unconfirmed.status).toBe(1);
    expect(unconfirmed.stderr).toContain("needs --yes");
    expect(await userCount(live)).toBe(2);

    const result = run(RESTORE, ["--yes", file], baseEnv(newDir("r"), { POSTGRES_DB: live }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Restore complete: "${live}" now holds`);
    expect(await userCount(live)).toBe(1);
    const kept = await admin<{ datname: string }[]>`select datname from pg_database where datname like ${`${live}_before_%`}`;
    expect(kept).toHaveLength(1);
    expect(await userCount(kept[0]!.datname)).toBe(2);
  });

  it("a7-backup-deploy-secrets-04: restore reads the repository's .env from any directory, never runs it, and an already-set value wins", async () => {
    const { file } = goodBackup();
    // A checkout: <repo>/deploy/restore.sh beside <repo>/.env, run from somewhere else entirely.
    const repo = newDir("repo");
    mkdirSync(path.join(repo, "deploy"));
    copyFileSync(RESTORE, path.join(repo, "deploy", "restore.sh"));
    const ran = path.join(repo, "ran");
    writeFileSync(
      path.join(repo, ".env"),
      [
        `POSTGRES_USER=${pg.user}`,
        `POSTGRES_PASSWORD="${pg.password}"`,
        `POSTGRES_DB=${source.databaseName}`,
        `BACKUP_PASSPHRASE='${PASSPHRASE}'`,
        `BACKUP_COPY_CMD=rclone copy "$1" remote:meridian-backups`,
        `SITE_ADDRESS=$(touch ${ran})`,
        "",
      ].join("\n"),
    );
    const env = baseEnv(newDir("r"));
    for (const key of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "BACKUP_PASSPHRASE", "MERIDIAN_ENV_FILE"]) delete env[key];
    const target = `${source.databaseName}_scratch5`;
    const result = run(path.join(repo, "deploy", "restore.sh"), ["--target-db", target, file], env, tmpdir());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Restore complete: "${target}" holds`);
    expect(await userCount(target)).toBe(1);
    expect(existsSync(ran)).toBe(false);

    // POSTGRES_DB already set wins over the file: the restore aims at it, and the database the
    // file names is untouched (no _restore_ or _before_ copy of it appears).
    const aimed = `${source.databaseName}_aimed6`;
    const second = run(path.join(repo, "deploy", "restore.sh"), ["--yes", file], { ...env, POSTGRES_DB: aimed }, tmpdir());
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain(`"${aimed}" now holds`);
    expect(await userCount(aimed)).toBe(1);
    const touched = await admin<{ datname: string }[]>`select datname from pg_database where datname like ${`${source.databaseName}_before_%`} or datname like ${`${source.databaseName}_restore_%`}`;
    expect(touched).toEqual([]);
  });

  it("a7-backup-deploy-secrets-08: the restore check restores the newest backup into a throwaway database and records the result", async () => {
    const { root } = goodBackup();
    const ok = run(RESTORE_CHECK, [], baseEnv(root));
    expect(ok.status, ok.stderr + ok.stdout).toBe(0);
    expect(ok.stdout).toMatch(/Restore check passed: .* \(\d+ migrations, \d+ tables, 1 members, 0 accounts, 0 transactions\)/);
    expect(readFileSync(path.join(root, "status", "restore-check"), "utf8")).toMatch(/^\d+ ok meridian-\d{8}T\d{6}Z\.sql\.gz\.enc/);
    const left = await admin<{ datname: string }[]>`select datname from pg_database where datname like ${`${source.databaseName}_rc_%`}`;
    expect(left).toEqual([]);

    // A damaged newest file fails the check and says so.
    const newest = files(path.join(root, "daily")).at(-1)!;
    const damaged = path.join(root, "daily", newest.replace(/T\d{6}Z/, "T235959Z"));
    writeFileSync(damaged, readFileSync(path.join(root, "daily", newest)).subarray(0, 200));
    const bad = run(RESTORE_CHECK, [], baseEnv(root));
    expect(bad.status).toBe(1);
    expect(readFileSync(path.join(root, "status", "restore-check"), "utf8")).toMatch(/^\d+ failed .*does not read back/);
    expect(await userCount(source.databaseName)).toBe(1);
  });
});
