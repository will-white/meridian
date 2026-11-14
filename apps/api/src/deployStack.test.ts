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

/** A Dockerfile's stages, from each FROM to the next: named by their `AS`, the last one "final". */
function dockerStages(file: string): Map<string, string> {
  const chunks = repo(file)
    .split(/^(?=FROM )/m)
    .filter((chunk) => chunk.startsWith("FROM "));
  return new Map(chunks.map((chunk, i) => [i === chunks.length - 1 ? "final" : (/^FROM \S+ AS (\S+)/i.exec(chunk)?.[1] ?? `stage${i}`), chunk]));
}

/** `ENV NAME=value` lines of a stage. */
const dockerEnv = (stage: string): Record<string, string> => Object.fromEntries([...stage.matchAll(/^ENV ([A-Z][A-Z0-9_]*)=(\S+)$/gm)].map((m) => [m[1]!, m[2]!]));

/**
 * The production dependencies pnpm installs for one importer of pnpm-lock.yaml: its
 * `dependencies` and everything they need (dependencies and optionalDependencies of each
 * snapshot), as `name@version(peers)` keys. Workspace links are skipped: the bundles compile
 * @meridian/* from source, and `pnpm install --prod --filter <app>` installs the app's own list.
 */
function prodClosure(importer: string): Set<string> {
  const unquote = (s: string) => s.replace(/^'(.*)'$/, "$1");
  const direct = new Map<string, string[]>();
  const snapshots = new Map<string, string[]>();
  let section = "";
  let entry = "";
  let group = "";
  let dependency = "";
  for (const line of repo("pnpm-lock.yaml").split("\n")) {
    let m: RegExpExecArray | null;
    if (/^\S/.test(line)) section = line.replace(/:.*$/, "");
    else if ((m = /^ {2}(\S.*?):( \{\})?$/.exec(line))) [entry, group] = [unquote(m[1]!), ""];
    else if ((m = /^ {4}(\S+):$/.exec(line))) group = m[1]!;
    else if (section === "importers" && group === "dependencies") {
      if ((m = /^ {6}(\S.*):$/.exec(line))) dependency = unquote(m[1]!);
      else if ((m = /^ {8}version: (\S+)$/.exec(line)) && !m[1]!.startsWith("link:")) direct.set(entry, [...(direct.get(entry) ?? []), `${dependency}@${m[1]!}`]);
    } else if (section === "snapshots" && (group === "dependencies" || group === "optionalDependencies") && (m = /^ {6}(\S.*): (\S+)$/.exec(line))) {
      snapshots.set(entry, [...(snapshots.get(entry) ?? []), `${unquote(m[1]!)}@${unquote(m[2]!)}`]);
    }
  }
  const seen = new Set<string>();
  const queue = [...(direct.get(importer) ?? [])];
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(...(snapshots.get(key) ?? []));
  }
  return seen;
}
const packageName = (key: string) => key.slice(0, key.indexOf("@", 1));

describe("the API and worker images carry only what they run (audit a9-dependencies)", () => {
  const images = [
    { file: "apps/api/Dockerfile", app: "api" },
    { file: "apps/worker/Dockerfile", app: "worker" },
  ] as const;

  it("a9-dependencies-01: the image installs nothing itself: its node_modules come from a stage that ran the production install", () => {
    for (const { file, app } of images) {
      const stages = dockerStages(file);
      const final = stages.get("final")!;
      // No package manager, store or cache in the image: nothing runs there at all.
      expect(final, file).not.toMatch(/^RUN /m);
      expect(final, file).not.toMatch(/corepack|pnpm/);
      // Everything in it is copied from an earlier stage.
      for (const copy of final.match(/^COPY .*$/gm) ?? []) expect(copy, file).toMatch(/^COPY --from=\S+ /);
      const from = (path: string) => new RegExp(`^COPY --from=(\\S+) /app/${path} \\./${path}$`, "m").exec(final)?.[1];
      for (const modules of ["node_modules", `apps/${app}/node_modules`]) {
        const stage = from(modules);
        expect(stage, `${file} copies ${modules}`).toBeDefined();
        expect(stages.get(stage!), `${file} stage ${stage}`).toMatch(new RegExp(`^RUN pnpm install --frozen-lockfile --prod --filter @meridian/${app}$`, "m"));
      }
    }
  });

  it("a9-dependencies-01: only the API image carries the migrations, because only the API runs them", () => {
    expect(repo("apps/api/src/boot.ts")).toMatch(/await runMigrations\(db\)/);
    const workerSources = spawnSync("git", ["grep", "-l", "runMigrations", "--", "apps/worker/src"], { cwd: root, encoding: "utf8" });
    expect(workerSources.stdout).toBe("");
    const api = dockerStages("apps/api/Dockerfile").get("final")!;
    expect(api).toMatch(/^COPY --from=build \/app\/packages\/db\/drizzle \.\/packages\/db\/drizzle$/m);
    expect(dockerEnv(api)["MERIDIAN_MIGRATIONS_DIR"]).toBe("/app/packages/db/drizzle");
    const worker = dockerStages("apps/worker/Dockerfile").get("final")!;
    expect(worker).not.toMatch(/drizzle/);
    expect(dockerEnv(worker)["MERIDIAN_MIGRATIONS_DIR"]).toBeUndefined();
    // The compose file agrees: the worker is not told where migrations are.
    const services = repo("deploy/services.yml");
    const block = (name: string) => services.slice(services.indexOf(`\n  ${name}:\n`), services.indexOf("\n\n", services.indexOf(`\n  ${name}:\n`)));
    expect(block("web")).toMatch(/- MERIDIAN_MIGRATIONS_DIR=\/app\/packages\/db\/drizzle/);
    expect(block("worker")).not.toMatch(/MERIDIAN_MIGRATIONS_DIR/);
  });

  it("a9-dependencies-01: the production install of the API and the worker holds no React (drizzle-orm's optional peers stay unresolved)", () => {
    // What the bundles import at run time is there (so the closure was read), React is not.
    const imported = {
      "apps/api": ["drizzle-orm", "postgres", "zod", "re2js", "fastify", "@node-rs/argon2", "@fastify/static"],
      "apps/worker": ["drizzle-orm", "postgres", "zod", "re2js"],
      "packages/db": ["drizzle-orm", "postgres"],
    };
    for (const [importer, needed] of Object.entries(imported)) {
      const names = new Set([...prodClosure(importer)].map(packageName));
      for (const name of needed) expect(names.has(name), `${importer} ${name}`).toBe(true);
      for (const stray of ["react", "react-dom", "@types/react", "csstype"]) expect(names.has(stray), `${importer} ${stray}`).toBe(false);
    }
  });

  it("a9-dependencies-02: the images run the bundles with their source maps, so a logged stack names the source file and line", () => {
    for (const { file, app } of images) {
      const final = dockerStages(file).get("final")!;
      expect(final, file).toMatch(new RegExp(`^COPY --from=build /app/apps/${app}/dist \\./apps/${app}/dist$`, "m"));
      expect(dockerEnv(final)["NODE_OPTIONS"], file).toBe("--enable-source-maps");
    }
    // A bundle built by scripts/bundle.mjs, run with the images' NODE_OPTIONS: the stack names
    // thrower.ts line 2 (where it throws), not a line of the bundle.
    const dir = mkdtempSync(path.join(scratch, "bundle-"));
    writeFileSync(path.join(dir, "thrower.ts"), 'export function explode(): never {\n  throw new Error("probe failure");\n}\n');
    writeFileSync(path.join(dir, "entry.ts"), 'import { explode } from "./thrower.js";\n\nexplode();\n');
    const built = spawnSync(process.execPath, [path.join(root, "scripts/bundle.mjs"), path.join(dir, "entry.ts"), path.join(dir, "dist/entry.js")], { encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
    const env = { PATH: process.env["PATH"], NODE_OPTIONS: dockerEnv(dockerStages("apps/api/Dockerfile").get("final")!)["NODE_OPTIONS"] };
    const run = spawnSync(process.execPath, [path.join(dir, "dist/entry.js")], { encoding: "utf8", env });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("probe failure");
    expect(run.stderr).toMatch(/at explode \(\S*thrower\.ts:2:\d+\)/);
    expect(run.stderr).not.toMatch(/entry\.js:\d+/);
    // The maps carry positions only: the image has no use for a second copy of every source file.
    const map = JSON.parse(readFileSync(path.join(dir, "dist/entry.js.map"), "utf8")) as { sources: string[]; sourcesContent?: unknown };
    expect(map.sources.map((s) => path.basename(s)).sort()).toEqual(["entry.ts", "thrower.ts"]);
    expect(map.sourcesContent).toBeUndefined();
  });
});
