import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The compose stack, the Dockerfiles and the ignore rules (audit a7-backup-deploy-secrets 01,
 * 07, 10 to 13, 15, 16, 18). The rendered stack comes from `docker compose config`, which needs
 * the Docker CLI but no daemon, run on a scratch copy of deploy/ with a scratch .env of marker
 * values; the text checks run everywhere.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const repo = (relative: string) => readFileSync(path.join(root, relative), "utf8");
const haveCompose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

interface Service {
  environment?: Record<string, string | null>;
  ports?: { published?: string; host_ip?: string }[];
  networks?: Record<string, unknown>;
  healthcheck?: { test?: string[] };
  depends_on?: Record<string, { condition?: string }>;
  secrets?: { source: string }[];
  image?: string;
  build?: { dockerfile?: string; args?: Record<string, string> };
}
interface Stack {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean }>;
}

const scratch = mkdtempSync(path.join(tmpdir(), "meridian-compose-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The stack as compose renders it from deploy/ and an .env.example with `overrides` applied. */
function render(overrides: Record<string, string> = {}, extraFiles: string[] = []): Stack {
  const dir = mkdtempSync(path.join(scratch, "stack-"));
  cpSync(path.join(root, "deploy"), path.join(dir, "deploy"), { recursive: true });
  const lines = repo(".env.example").split("\n");
  const seen = new Set<string>();
  const env = lines.map((line) => {
    const key = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (key && key in overrides) {
      seen.add(key);
      return `${key}=${overrides[key]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(overrides)) if (!seen.has(key)) env.push(`${key}=${value}`);
  writeFileSync(path.join(dir, ".env"), env.join("\n"));
  const files = ["deploy/docker-compose.yml", ...extraFiles].flatMap((f) => ["-f", f]);
  const result = spawnSync("docker", ["compose", ...files, "config", "--format", "json"], { cwd: dir, encoding: "utf8", env: { PATH: process.env["PATH"], HOME: dir } });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Stack;
}

const MARKERS = {
  SECRETS_KEY: "PROBE_SECRETS_KEY",
  SESSION_SECRET: "PROBE_SESSION_SECRET_0123456789abcdef",
  TIINGO_API_KEY: "PROBE_TIINGO",
  BACKUP_PASSPHRASE: "PROBE_BACKUP_PASSPHRASE",
  POSTGRES_PASSWORD: "PROBE_DB_PASSWORD",
  SITE_ADDRESS: "probe.example",
};
const holders = (stack: Stack, value: string) =>
  Object.entries(stack.services)
    .filter(([, s]) => Object.values(s.environment ?? {}).some((v) => v === value))
    .map(([name]) => name)
    .sort();

describe.skipIf(!haveCompose)("deploy stack as compose renders it", () => {
  it("a7-backup-deploy-secrets-07: each container gets only the secrets it reads", () => {
    const stack = render(MARKERS);
    expect(holders(stack, MARKERS.SECRETS_KEY)).toEqual(["web", "worker"]);
    expect(holders(stack, MARKERS.SESSION_SECRET)).toEqual(["web"]);
    expect(holders(stack, MARKERS.TIINGO_API_KEY)).toEqual(["worker"]);
    expect(holders(stack, MARKERS.BACKUP_PASSPHRASE)).toEqual(["backup"]);
    expect(holders(stack, MARKERS.POSTGRES_PASSWORD)).toEqual(["backup", "db", "web", "worker"]);
    const set = (name: string) => Object.keys(stack.services[name]!.environment ?? {}).filter((k) => stack.services[name]!.environment![k] !== null).sort();
    expect(set("proxy")).toEqual(["SITE_ADDRESS"]);
    expect(set("db")).toEqual(["POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER"]);
  });

  it("a7-backup-deploy-secrets-07: the Docker secrets file mounts SECRETS_KEY in web and worker only, and the Tiingo key in the worker", () => {
    const stack = render({ SECRETS_KEY: "", TIINGO_API_KEY: "" }, ["deploy/docker-compose.secrets.yml"]);
    const secrets = (name: string) => (stack.services[name]!.secrets ?? []).map((s) => s.source).sort();
    expect(secrets("web")).toEqual(["secrets_key"]);
    expect(secrets("worker")).toEqual(["secrets_key", "tiingo_api_key"]);
    for (const name of ["db", "proxy", "backup"]) expect(secrets(name), name).toEqual([]);
    expect(stack.services["web"]!.environment!["SECRETS_KEY_FILE"]).toBe("/run/secrets/secrets_key");
    expect(stack.services["worker"]!.environment!["SECRETS_KEY_FILE"]).toBe("/run/secrets/secrets_key");
    expect(stack.services["worker"]!.environment!["TIINGO_API_KEY_FILE"]).toBe("/run/secrets/tiingo_api_key");
  });

  it("a7-backup-deploy-secrets-10: only Caddy publishes ports; the development file adds the database on loopback", () => {
    const stack = render();
    const published = Object.entries(stack.services).filter(([, s]) => (s.ports ?? []).length > 0).map(([n]) => n);
    expect(published).toEqual(["proxy"]);
    const dev = render({}, ["deploy/docker-compose.dev.yml"]);
    expect(dev.services["db"]!.ports).toEqual([expect.objectContaining({ host_ip: "127.0.0.1", published: "5432" })]);
  });

  it("a7-backup-deploy-secrets-11: BACKUP_HOUR in .env reaches the backup container", () => {
    expect(render({ BACKUP_HOUR: "5" }).services["backup"]!.environment!["BACKUP_HOUR"]).toBe("5");
    expect(render({ BACKUP_COPY_CMD: `'rclone copy "$1" "offsite:meridian/$2"'` }).services["backup"]!.environment!["BACKUP_COPY_CMD"]).toBe('rclone copy "$$1" "offsite:meridian/$$2"');
  });

  it("a7-backup-deploy-secrets-16: db and web have no route out; only the worker, backup and the proxy's published network do", () => {
    const stack = render();
    expect(stack.networks["internal"]?.internal).toBe(true);
    const nets = (name: string) => Object.keys(stack.services[name]!.networks ?? {}).sort();
    expect(nets("db")).toEqual(["internal"]);
    expect(nets("web")).toEqual(["internal"]);
    expect(nets("worker")).toEqual(["egress", "internal"]);
    expect(nets("backup")).toEqual(["egress", "internal"]);
    expect(nets("proxy")).toEqual(["edge", "internal"]);
    for (const net of ["egress", "edge"]) expect(stack.networks[net]?.internal ?? false, net).toBe(false);
  });

  it("a7-backup-deploy-secrets-18: every service has a healthcheck, and the proxy waits for a healthy web", () => {
    const stack = render();
    for (const [name, service] of Object.entries(stack.services)) expect(service.healthcheck?.test?.length, name).toBeGreaterThan(0);
    expect(stack.services["backup"]!.healthcheck!.test).toEqual(["CMD", "/bin/sh", "/backup.sh", "--health"]);
    expect(stack.services["worker"]!.healthcheck!.test!.join(" ")).toContain("WORKER_HEARTBEAT_FILE");
    expect(stack.services["worker"]!.environment!["WORKER_HEARTBEAT_FILE"]).toBe("/tmp/meridian-worker-heartbeat");
    expect(stack.services["proxy"]!.depends_on!["web"]!.condition).toBe("service_healthy");
  });

  it("a7-backup-deploy-secrets-13: the base images come from the *_IMAGE settings, so a digest pinned in .env reaches every build", () => {
    const pinned = "postgres:16-alpine@sha256:" + "a".repeat(64);
    const stack = render({ POSTGRES_IMAGE: pinned, NODE_IMAGE: "node:22-alpine@sha256:" + "b".repeat(64), CADDY_IMAGE: "caddy:2-alpine@sha256:" + "c".repeat(64) });
    expect(stack.services["db"]!.image).toBe(pinned);
    expect(stack.services["backup"]!.build!.args!["POSTGRES_IMAGE"]).toBe(pinned);
    expect(stack.services["web"]!.build!.args!["NODE_IMAGE"]).toContain("@sha256:" + "b".repeat(64));
    expect(stack.services["worker"]!.build!.args!["NODE_IMAGE"]).toContain("@sha256:" + "b".repeat(64));
    expect(stack.services["proxy"]!.image).toContain("@sha256:" + "c".repeat(64));
  });

  it("a7-backup-deploy-secrets-07: every setting the API and the worker read is passed to their container", () => {
    const stack = render();
    // Read outside Docker only, or set by the image itself.
    const notPassed = new Set(["DATABASE_URL", "MERIDIAN_DB_PORT", "WEB_DIST_DIR", "TEST_DATABASE_URL", "TEST_DATABASE_PREFIX"]);
    const readBy = (dir: string) => {
      const names = new Set<string>();
      const walk = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
            const text = readFileSync(full, "utf8");
            for (const m of text.matchAll(/env\[["']([A-Z][A-Z0-9_]*)["']\]|process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add((m[1] ?? m[2])!);
          }
        }
      };
      walk(path.join(root, dir));
      return [...names].filter((n) => !notPassed.has(n));
    };
    const apiEnvSchema = [...repo("apps/api/src/config.ts").slice(repo("apps/api/src/config.ts").indexOf("const Env = z.object({")).split("});")[0]!.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!);
    for (const [service, names] of [
      ["web", [...readBy("apps/api/src"), ...apiEnvSchema.filter((n) => !notPassed.has(n))]],
      ["worker", readBy("apps/worker/src")],
    ] as const) {
      const passed = Object.keys(stack.services[service]!.environment ?? {});
      for (const name of names) expect(passed, `${service} reads ${name}`).toContain(name);
    }
  });
});

describe("deploy files as text", () => {
  it("a7-backup-deploy-secrets-01: the backup service is built with the tools its scripts need", () => {
    const services = repo("deploy/services.yml");
    expect(services).toMatch(/backup:\n\s+build:\n\s+context: \.\n\s+dockerfile: backup\.Dockerfile/);
    const image = repo("deploy/backup.Dockerfile");
    expect(image).toMatch(/apk add --no-cache openssl rclone openssh-client su-exec/);
    expect(image).toMatch(/COPY --chmod=0755 backup\.sh restore\.sh restore-check\.sh \//);
    expect(image).toMatch(/^ENV BACKUP_ROOT=\/backups \\\n\s+BACKUP_RUN_AS=postgres/m);
  });

  it("a7-backup-deploy-secrets-12: the API and worker images run as the node user", () => {
    for (const file of ["apps/api/Dockerfile", "apps/worker/Dockerfile"]) {
      const text = repo(file);
      const runtime = text.slice(text.lastIndexOf("\nFROM "));
      expect(runtime, file).toMatch(/^USER node$/m);
      // Nothing runs as root after the switch.
      expect(runtime.slice(runtime.indexOf("USER node")), file).not.toMatch(/^RUN /m);
    }
  });

  it("a7-backup-deploy-secrets-13: every FROM names its image through an ARG, and pnpm is pinned by hash", () => {
    for (const file of ["apps/api/Dockerfile", "apps/worker/Dockerfile", "deploy/backup.Dockerfile"]) {
      const froms = [...repo(file).matchAll(/^FROM (\S+)/gm)].map((m) => m[1]!);
      expect(froms.length, file).toBeGreaterThan(0);
      for (const from of froms) expect(from, file).toMatch(/^\$\{(NODE|POSTGRES)_IMAGE\}$/);
    }
    expect(JSON.parse(repo("package.json")).packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
  });

  it("a7-backup-deploy-secrets-15: Docker secret files and the off-site copy's keys are git-ignored", () => {
    const paths = ["deploy/secrets/secrets_key", "deploy/secrets/tiingo_api_key", "deploy/backup-config/rclone.conf", "deploy/backup-config/id_ed25519", "deploy/backups/daily/x.enc", ".env"];
    const result = spawnSync("git", ["check-ignore", "--no-index", ...paths], { cwd: root, encoding: "utf8" });
    expect(result.stdout.trim().split("\n").sort()).toEqual([...paths].sort());
    expect(spawnSync("git", ["check-ignore", "--no-index", ".env.example"], { cwd: root }).status).toBe(1);
  });
});
