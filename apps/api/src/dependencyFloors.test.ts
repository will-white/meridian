import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Decision 119's rule for `pnpm-workspace.yaml`: every range in the lockfile's graph that
 * admits a release an advisory names is held above it, by the workspace's own manifest, by an
 * override past the parent's range, or by a floor override inside it. Then no re-resolution
 * (an update, a parent upgraded, a merge that brings an older lockfile's resolution back) can
 * pick a vulnerable release, and the floors are applied by one rule rather than case by case.
 *
 * The ranges a package asks for are read from its package.json under node_modules/.pnpm, for
 * the snapshots pnpm-lock.yaml lists (so a stale directory left by an older install is not
 * read). Peer ranges are not checked: pnpm gives a peer the importer's own copy (checked here
 * as a manifest range) or, with autoInstallPeers, the copy the workspace already has.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const repo = (relative: string) => readFileSync(path.join(root, relative), "utf8");

/**
 * The releases the advisories closed by decision 119 name, as the npm advisory database gave
 * them to `pnpm audit` (2026-11-14), merged per package into [from, to) intervals. Zod's and
 * deepmerge's are kept on purpose (decisions 117 and 118) and are not listed.
 */
const VULNERABLE: Record<string, [string, string][]> = {
  // GHSA-83w8-p2f5-377r <=10.1.0, GHSA-8pvw-jcv7-9cmj <=10.1.1, GHSA-pr96-94w5-mx2h and GHSA-x428-ghpx-8j92 >=8.0.0 <=9.1.0
  "@fastify/static": [["0.0.0", "10.1.2"]],
  // GHSA-gpj5-g38j-94v9
  "drizzle-orm": [["0.0.0", "0.45.2"]],
  // GHSA-gg6h-894w-4m9c
  re2js: [["2.2.0", "2.8.7"]],
  // GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr, GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp, on both lines
  "fast-uri": [
    ["3.0.0", "3.1.9"],
    ["4.0.0", "4.2.3"],
  ],
  // GHSA-3g3m-2fjr-6pw4 >=9.0.0 <=14.0.1
  glob: [["9.0.0", "14.0.2"]],
  // GHSA-g3hv-75wg-m249
  minimatch: [["7.0.0", "11.0.1"]],
  // GHSA-m5mm-p8h7-m29v
  "serialize-javascript": [["0.0.0", "7.1.3"]],
  // GHSA-67mh-4wv8-2f99 <=0.24.2
  esbuild: [["0.0.0", "0.25.0"]],
  // GHSA-4w7w-66w2-5vf9 to GHSA-rq7h-c2jc-7f22 (<=6.4.3) and GHSA-8g5g-mxqh-grgj (=6.4.4)
  vite: [["0.0.0", "6.4.5"]],
  // GHSA-5xrq-8626-4rwp <3.2.6, GHSA-82fw-gwwq-j7x9 <4.1.11
  vitest: [["0.0.0", "4.1.11"]],
  // GHSA-82fw-gwwq-j7x9 <4.1.11, GHSA-qxg6-89mg-rqv8 <4.1.12
  "@vitest/mocker": [["2.1.0", "4.1.12"]],
  // GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr
  tinypool: [["0.0.0", "2.1.2"]],
};

// ---- a small reading of npm ranges: enough for the forms the graph uses, and loud about any other ----

type Version = [number, number, number];
type Interval = [Version, Version]; // [from, to)
const MAX: Version = [Infinity, 0, 0];
const cmp = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const parse = (v: string): Version => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v);
  if (!m) throw new Error(`not a version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const nextPatch = ([a, b, c]: Version): Version => [a, b, c + 1];

/** A comparator's interval. Partial versions (`^14`, `~0.28`) and `x` wildcards count as their missing parts. */
function comparator(text: string): Interval {
  const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?$/.exec(text);
  if (!m) throw new Error(`range not understood: ${text}`);
  const [, op = "", major, minor, patch] = m;
  const wild = (s: string | undefined) => s === undefined || /^[xX*]$/.test(s);
  if (wild(major)) return [[0, 0, 0], MAX];
  const v: Version = [Number(major), wild(minor) ? 0 : Number(minor), wild(patch) ? 0 : Number(patch)];
  const parts = wild(minor) ? 1 : wild(patch) ? 2 : 3;
  // The first version past every one the (partial) version names: `1.2` names 1.2.x.
  const past: Version = parts === 1 ? [v[0] + 1, 0, 0] : parts === 2 ? [v[0], v[1] + 1, 0] : nextPatch(v);
  switch (op) {
    case "^":
      return [v, v[0] > 0 || parts === 1 ? [v[0] + 1, 0, 0] : v[1] > 0 || parts === 2 ? [0, v[1] + 1, 0] : [0, 0, v[2] + 1]];
    case "~":
      return [v, parts === 1 ? [v[0] + 1, 0, 0] : [v[0], v[1] + 1, 0]];
    case ">=":
      return [v, MAX];
    case ">":
      return [past, MAX];
    case "<=":
      return [[0, 0, 0], past];
    case "<":
      return [[0, 0, 0], v];
    default:
      return [v, past];
  }
}

/** A range as the union of its `||` alternatives, each the intersection of its comparators. */
function intervals(range: string): Interval[] {
  return range.split("||").map((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    if (comparators.includes("-")) throw new Error(`hyphen range not understood: ${range}`);
    return comparators.map(comparator).reduce<Interval>(([lo, hi], [l, h]) => [cmp(l, lo) > 0 ? l : lo, cmp(h, hi) < 0 ? h : hi], [[0, 0, 0], MAX]);
  });
}
const overlaps = ([lo, hi]: Interval, [l, h]: Interval) => cmp(lo, h) < 0 && cmp(l, hi) < 0;
const within = ([lo, hi]: Interval, [l, h]: Interval) => cmp(lo, l) >= 0 && cmp(hi, h) <= 0;
/** Whether `range` lets pnpm pick a release `name`'s advisories name. */
const admitsVulnerable = (name: string, range: string) => {
  const bad = (VULNERABLE[name] ?? []).map(([from, to]): Interval => [parse(from), parse(to)]);
  return intervals(range).some((alt) => bad.some((b) => overlaps(alt, b)));
};

// ---- the lockfile, the overrides and the ranges each package asks for ----

interface Snapshot {
  name: string;
  version: string;
  optional: boolean;
}
function snapshots(): Snapshot[] {
  const out: Snapshot[] = [];
  let section = "";
  for (const line of repo("pnpm-lock.yaml").split("\n")) {
    let m: RegExpExecArray | null;
    if (/^\S/.test(line)) section = line.replace(/:.*$/, "");
    else if (section !== "snapshots") continue;
    else if ((m = /^ {2}'?((?:@[^/\s']+\/)?[^@\s']+)@([^(':\s]+)/.exec(line))) out.push({ name: m[1]!, version: m[2]!, optional: false });
    else if (/^ {4}optional: true$/.test(line)) out[out.length - 1]!.optional = true;
  }
  return out;
}

/** `pnpm-workspace.yaml`'s overrides: by parent (`parent>name`) or by the range they replace (`name@selector`). */
function overrides(): { parent?: string; name: string; selector?: string; value: string }[] {
  const text = repo("pnpm-workspace.yaml");
  const block = text.slice(text.indexOf("\noverrides:\n") + "\noverrides:\n".length);
  return [...block.matchAll(/^ {2}"([^"]+)": "([^"]*)"$/gm)].map(([, key, value]) => {
    const [target, parent] = key!.split(">").reverse() as [string, string | undefined];
    const at = target.indexOf("@", 1);
    return { ...(parent ? { parent } : {}), name: at > 0 ? target.slice(0, at) : target, ...(at > 0 ? { selector: target.slice(at + 1) } : {}), value: value! };
  });
}

describe("decision 119: every range that admits a vulnerable release is held above it", () => {
  const store = path.join(root, "node_modules/.pnpm");
  const dirs = readdirSync(store);
  const all = snapshots();
  const rules = overrides();

  it("the range reader reads the forms the graph uses", () => {
    expect(admitsVulnerable("glob", "^14.0.0")).toBe(true);
    expect(admitsVulnerable("glob", "^14.0.2")).toBe(false);
    expect(admitsVulnerable("glob", "^11.0.1")).toBe(true);
    expect(admitsVulnerable("minimatch", "^3.1.5")).toBe(false);
    expect(admitsVulnerable("minimatch", "^10.2.2")).toBe(true);
    expect(admitsVulnerable("fast-uri", "^3.0.1")).toBe(true);
    expect(admitsVulnerable("fast-uri", "^4.2.3")).toBe(false);
    expect(admitsVulnerable("esbuild", "~0.28.0")).toBe(false);
    expect(admitsVulnerable("esbuild", "^0.24.0")).toBe(true);
    expect(admitsVulnerable("vite", "^6.0.0 || ^7.0.0 || ^8.0.0")).toBe(true);
    expect(admitsVulnerable("vite", "^6.4.5")).toBe(false);
    expect(admitsVulnerable("@fastify/static", ">=10.1.2 <11")).toBe(false);
    expect(admitsVulnerable("@fastify/static", "<=10.1.1")).toBe(true);
    expect(admitsVulnerable("re2js", "2.8.7")).toBe(false);
    expect(admitsVulnerable("re2js", "2.8.6")).toBe(true);
    expect(admitsVulnerable("drizzle-orm", "^0.45.4")).toBe(false);
    expect(admitsVulnerable("drizzle-orm", "^0.44.0")).toBe(true);
    expect(within(intervals("^14.0.0")[0]!, intervals("^14")[0]!)).toBe(true);
    expect(within(intervals("^11.0.1")[0]!, intervals("^14")[0]!)).toBe(false);
    expect(() => intervals("1.0.0 - 2.0.0")).toThrow();
  });

  it("the lockfile resolves no release an advisory names", () => {
    const vulnerable = all.filter((s) => VULNERABLE[s.name] && admitsVulnerable(s.name, s.version)).map((s) => `${s.name}@${s.version}`);
    expect(vulnerable).toEqual([]);
    // The table is read against what is there: each package it names but tinypool (gone with vitest 2) is in the graph.
    const names = new Set(all.map((s) => s.name));
    expect(Object.keys(VULNERABLE).filter((name) => !names.has(name))).toEqual(["tinypool"]);
  });

  it("the workspace's own manifests ask for fixed releases only", () => {
    const manifests = ["package.json", ...["apps", "packages"].flatMap((dir) => readdirSync(path.join(root, dir)).map((name) => `${dir}/${name}/package.json`))].filter((file) => existsSync(path.join(root, file)));
    const asked: string[] = [];
    for (const file of manifests) {
      const manifest = JSON.parse(repo(file)) as Record<string, Record<string, string> | undefined>;
      for (const kind of ["dependencies", "devDependencies", "optionalDependencies"])
        for (const [name, range] of Object.entries(manifest[kind] ?? {})) if (VULNERABLE[name] && admitsVulnerable(name, range)) asked.push(`${file} ${kind} ${name} ${range}`);
    }
    expect(asked).toEqual([]);
  });

  it("every dependency range a package in the graph declares is fixed, or an override takes it past or above every vulnerable release", () => {
    for (const rule of rules) if (rule.value !== "-" && VULNERABLE[rule.name]) expect(admitsVulnerable(rule.name, rule.value), `override ${JSON.stringify(rule)}`).toBe(false);
    const uncovered: string[] = [];
    let read = 0;
    const seen = new Set<string>();
    for (const s of all) {
      const id = `${s.name}@${s.version}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const prefix = `${s.name.replace("/", "+")}@${s.version}`;
      const dir = dirs.find((d) => d === prefix || d.startsWith(`${prefix}_`));
      if (!dir) {
        // Another platform's binary package; anything else means node_modules is behind the lockfile.
        expect(s.optional, `${id} is not installed: run pnpm install`).toBe(true);
        continue;
      }
      const manifest = JSON.parse(readFileSync(path.join(store, dir, "node_modules", s.name, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
      read++;
      const peers = manifest["peerDependencies"] ?? {};
      for (const kind of ["dependencies", "optionalDependencies"])
        for (const [name, range] of Object.entries(manifest[kind] ?? {})) {
          if (!VULNERABLE[name] || name in peers || !admitsVulnerable(name, range)) continue;
          const parentRule = rules.find((r) => r.parent === s.name && r.name === name);
          const rangeRule = rules.find((r) => !r.parent && r.name === name && r.selector !== undefined && intervals(range).every((alt) => intervals(r.selector!).some((sel) => within(alt, sel))));
          if (!parentRule && !rangeRule) uncovered.push(`${id} asks for ${name} ${range}`);
        }
    }
    expect(read).toBeGreaterThan(100);
    expect(uncovered).toEqual([]);
  });
});
