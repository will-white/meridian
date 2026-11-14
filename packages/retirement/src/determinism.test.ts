import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// T46 (engine-and-returns §7, §3.14 item 5): the determinism source scan. Two layers enforce the
// same rule: this scan (part of `pnpm test`) and the root ESLint block (part of `pnpm lint`).
// The scan parses with the TypeScript compiler, so comments (`/** … */`), strings and regular
// expressions never count, and `Math["exp"]` or `const { exp } = Math` cannot slip past it.
//
// Both layers are an allow-list (engine decision 21): the core uses + − × ÷ and only the Math
// functions ECMAScript defines exactly. Every other Math member (exp, log, pow, the trigonometric
// and hyperbolic functions and their inverses, cbrt, hypot, random, …) is flagged, and so is any
// way around the name: a computed member `Math[x]`, an alias (`const M = Math`), `globalThis.Math`
// and `globalThis.Date`. The scan covers the engine's sources and the shared retirement code the
// engine runs (`packages/shared/src/retirement`, tests excluded).

/** The Math members the engine may use: each is exact (correctly rounded or an integer operation). */
const ALLOWED_MATH = new Set(["sqrt", "floor", "ceil", "trunc", "round", "abs", "min", "max", "imul", "sign", "fround"]);
/** The names a script can reach the global object by. */
const GLOBAL_OBJECT = new Set(["globalThis", "window", "self", "global"]);
/** Members of `Math` that are not on the allow-list (for the fixtures). */
const NOT_ALLOWED_MATH = [
  "exp", "log", "log2", "log10", "log1p", "expm1", "pow",
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
  "cbrt", "hypot", "random", "clz32",
];

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SHARED_RETIREMENT_DIR = join(REPO_ROOT, "packages/shared/src/retirement");
const SOURCE_FILE = /\.(ts|mts|cts|js|mjs|cjs)$/;

interface Finding {
  line: number;
  what: string;
}

function isMath(node: ts.Node): node is ts.Identifier {
  return ts.isIdentifier(node) && node.text === "Math";
}

/**
 * True when the expression holds a bigint literal or a `BigInt(…)` call: then a `**` in it is bigint
 * arithmetic, which is exact (mixing bigint and number throws). The ESLint block uses the same test.
 */
function holdsBigInt(node: ts.Node): boolean {
  if (ts.isBigIntLiteral(node)) return true;
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "BigInt") return true;
  return ts.forEachChild(node, holdsBigInt) === true;
}

/**
 * The identifier `Math` where it is allowed to stand: the object of a member access (checked
 * above), the initializer of a destructuring (checked above), a property name (`o.Math`,
 * `{ Math: 1 }`) or a name inside a type.
 */
function isMathMemberBase(node: ts.Identifier): boolean {
  const p = node.parent;
  if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === node) return true;
  if (ts.isVariableDeclaration(p) && ts.isObjectBindingPattern(p.name) && p.initializer === node) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return true;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === node) return true;
  return ts.isQualifiedName(p) || ts.isTypeQueryNode(p) || ts.isTypeReferenceNode(p);
}

/** Every banned construct in one source text. */
export function scanSource(text: string, fileName = "fixture.ts"): Finding[] {
  const kind = /\.(js|mjs|cjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found: Finding[] = [];
  const add = (node: ts.Node, what: string) => {
    found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, what });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isMath(node.expression)) {
      if (!ALLOWED_MATH.has(node.name.text)) add(node, `Math.${node.name.text}`);
    } else if (ts.isElementAccessExpression(node) && isMath(node.expression)) {
      const arg = node.argumentExpression;
      if (!(ts.isStringLiteralLike(arg) && ALLOWED_MATH.has(arg.text))) add(node, ts.isStringLiteralLike(arg) ? `Math["${arg.text}"]` : "Math[…]");
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isMath(node.initializer)) {
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        if (!((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && ALLOWED_MATH.has(key.text))) add(el, `{ ${key.getText(sf)} } = Math`);
      }
    } else if (isMath(node) && !isMathMemberBase(node)) {
      add(node, "Math alias");
    } else if (
      (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBAL_OBJECT.has(node.expression.text) && (node.name.text === "Math" || node.name.text === "Date")) ||
      (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBAL_OBJECT.has(node.expression.text))
    ) {
      add(node, `${(node.expression as ts.Identifier).text}.${ts.isPropertyAccessExpression(node) ? node.name.text : "[…]"}`);
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
        node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken) &&
      !holdsBigInt(node)
    ) {
      add(node.operatorToken, node.operatorToken.getText(sf));
    } else if (ts.isIdentifier(node) && node.text === "Date") {
      const p = node.parent;
      const isMemberName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) &&
          p.name === node);
      if (!isMemberName) add(node, "Date");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Engine source files: everything under `dir` except tests. */
function engineSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...engineSources(path));
    else if (SOURCE_FILE.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name)) out.push(path);
  }
  return out.sort();
}

describe("T46 determinism scan", () => {
  it("T46 the scan passes on the package", () => {
    const files = engineSources(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((f) => relative(SRC_DIR, f))).toContain("detmath.ts");
    const findings = files.flatMap((file) =>
      scanSource(readFileSync(file, "utf8"), file).map((f) => `${relative(SRC_DIR, file)}:${f.line} ${f.what}`),
    );
    expect(findings).toEqual([]);
  });

  it("T46 the scan passes on the shared retirement code the engine runs (vpwRawPercentageInto, glideWeightsAt, rankPaths, addUp, …)", () => {
    const files = engineSources(SHARED_RETIREMENT_DIR);
    expect(files.map((f) => relative(SHARED_RETIREMENT_DIR, f))).toEqual(expect.arrayContaining(["strategy.ts", "weights.ts", "percentile.ts", "results.ts"]));
    const findings = files.flatMap((file) =>
      scanSource(readFileSync(file, "utf8"), file).map((f) => `${relative(SHARED_RETIREMENT_DIR, file)}:${f.line} ${f.what}`),
    );
    expect(findings).toEqual([]);
  });

  it("T46 the scan fails on a fixture containing Math.exp(", () => {
    expect(scanSource("export const e = Math.exp(1);\n")).toEqual([{ line: 1, what: "Math.exp" }]);
  });

  it("T46 the scan fails on a fixture containing **", () => {
    expect(scanSource("const a = 2;\nexport const b = a ** 0.5;\n")).toEqual([{ line: 2, what: "**" }]);
    expect(scanSource("let a = 2;\na **= 3;\n")).toEqual([{ line: 2, what: "**=" }]);
    // Bigint powers are exact integer arithmetic (shared percentile.ts and results.ts use them).
    expect(scanSource("const a = 2n ** 63n;\nconst b = 10n ** BigInt(9);\nlet y = 3n;\nconst c = y ** (y - 1n);\n")).toEqual([]);
  });

  it("T46 the scan catches every Math member outside the allow-list and the indirect forms", () => {
    for (const name of NOT_ALLOWED_MATH) expect(scanSource(`Math.${name}(0.5);`), name).toEqual([{ line: 1, what: `Math.${name}` }]);
    for (const name of ALLOWED_MATH) expect(scanSource(`Math.${name}(0.5);`), name).toEqual([]);
    expect(scanSource(`const x = Math["pow"](2, 3);`)).toEqual([{ line: 1, what: 'Math["pow"]' }]);
    expect(scanSource(`const k = "sqrt"; const x = Math[k](2);`)).toEqual([{ line: 1, what: "Math[…]" }]);
    expect(scanSource(`const { log: ln, sqrt } = Math;`)).toEqual([{ line: 1, what: "{ log } = Math" }]);
    expect(scanSource(`const t = Date.now();\nconst d = new Date();`)).toEqual([
      { line: 1, what: "Date" },
      { line: 2, what: "Date" },
    ]);
  });

  it("T46 the scan catches the global object's Math and Date and an alias of Math (the review's fixture)", () => {
    const probe = ["export const t = globalThis.Date.now();", "export const r = globalThis.Math.random();", "const M = Math;", "export const p = M.pow(2, 0.5);", "export const h = Math.asinh(1);", ""].join("\n");
    expect(scanSource(probe)).toEqual([
      { line: 1, what: "globalThis.Date" },
      { line: 2, what: "globalThis.Math" },
      { line: 3, what: "Math alias" },
      { line: 5, what: "Math.asinh" },
    ]);
    expect(scanSource(`f(Math);`)).toEqual([{ line: 1, what: "Math alias" }]);
    expect(scanSource(`const g = window["Math"];`)).toEqual([{ line: 1, what: "window.[…]" }]);
    expect(scanSource(`const o = { Math: 1 }; const v = o.Math; type T = typeof Math;`)).toEqual([]);
  });

  it("T46 comments, strings and the allowed Math functions do not count", () => {
    const allowed = [
      "/** Uses x ** 2 and Math.exp(x) in prose only. */",
      "// Math.pow(2, 3) ** 2",
      'const s = "Math.exp(1) ** 2";',
      "const t = `Math.log(${1})`;",
      "const r = /Math\\.exp\\(/;",
      "const ok = Math.sqrt(2) + Math.floor(1.5) + Math.round(2.5) + Math.abs(-1) + Math.min(1, 2) + Math.max(1, 2) + Math.imul(3, 4);",
      "const o = { Date: 1, exp: 2 }; const v = o.Date + o.exp;",
    ].join("\n");
    expect(scanSource(allowed)).toEqual([]);
  });
});

/**
 * The module specifiers a source text imports: static imports and exports, `import("…")` with a
 * literal, and `require("…")`.
 */
function importsOf(text: string, fileName: string): string[] {
  const kind = /\.(js|mjs|cjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("the package's dependencies (seams §2.1: @meridian/shared and zod only)", () => {
  it("contracts-06: every non-test source under src/ imports only relative paths, @meridian/shared and zod; src/node may add node:* and, in its tsx boot entries, tsx", () => {
    const offending: string[] = [];
    for (const file of engineSources(SRC_DIR)) {
      const rel = relative(SRC_DIR, file);
      const inNode = rel.startsWith("node/");
      const bootEntry = inNode && rel.endsWith(".boot.mjs");
      for (const spec of importsOf(readFileSync(file, "utf8"), file)) {
        const ok =
          spec.startsWith("./") ||
          spec.startsWith("../") ||
          spec === "@meridian/shared" ||
          spec === "zod" ||
          (inNode && spec.startsWith("node:")) ||
          (bootEntry && spec === "tsx/esm/api");
        if (!ok) offending.push(`${rel}: ${spec}`);
      }
    }
    expect(offending).toEqual([]);
  });
});

describe("T46 the root ESLint block", () => {
  const lint = async (code: string, path: string): Promise<string[]> => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const [result] = await eslint.lintText(code, { filePath: join(REPO_ROOT, path), warnIgnored: true });
    return (result?.messages ?? []).map((m) => `${m.ruleId ?? "fatal"}: ${m.message}`);
  };
  const fixture = [
    "export const a = Math.exp(1);",
    "export const b = 2 ** 3;",
    "export const c = Math.random();",
    "export const d = Date.now();",
    "",
  ].join("\n");

  it("T46 rejects the banned functions, ** and Date in the engine core and the harness", async () => {
    const core = await lint(fixture, "packages/retirement/src/__fixture__.ts");
    // Math.exp and Math.random (the allow-list) and ** are syntax rules; Date is a global.
    expect(core.filter((m) => m.startsWith("no-restricted-syntax"))).toHaveLength(3);
    expect(core.filter((m) => m.startsWith("no-restricted-globals"))).toHaveLength(1);
    expect(core).toHaveLength(4);
    const harness = await lint(fixture, "packages/retirement/src/node/__fixture__.ts");
    expect(harness).toHaveLength(4);
  }, 60_000);

  it("T46 the allow-list: the review's fixture (globalThis.Date, globalThis.Math, an alias of Math, Math.asinh) fails in the core, the harness and the shared retirement code", async () => {
    const probe = ["export const t = globalThis.Date.now();", "export const r = globalThis.Math.random();", "const M = Math;", "export const p = M.pow(2, 0.5);", "export const h = Math.asinh(1);", ""].join("\n");
    for (const path of ["packages/retirement/src/__fixture__.ts", "packages/retirement/src/node/__fixture__.ts", "packages/shared/src/retirement/__fixture__.ts"]) {
      const messages = await lint(probe, path);
      expect(messages.filter((m) => m.startsWith("no-restricted-syntax")), path).toHaveLength(4);
    }
    for (const name of ["asin", "acos", "asinh", "acosh", "atanh"]) {
      expect(await lint(`export const x = Math.${name}(0.5);\n`, "packages/retirement/src/__fixture__.ts"), name).toHaveLength(1);
    }
    const allowed = `export const x = Math.sqrt(2) + Math.floor(1.5) + Math.ceil(1.5) + Math.trunc(1.5) + Math.round(1.5) + Math.abs(-1) + Math.min(1, 2) + Math.max(1, 2) + Math.imul(2, 3) + Math.sign(-2) + Math.fround(1.5);\n`;
    expect(await lint(allowed, "packages/retirement/src/__fixture__.ts")).toEqual([]);
    expect(await lint(allowed, "packages/shared/src/retirement/__fixture__.ts")).toEqual([]);
    // Tests of the shared retirement code may compare against Math.exp as the engine's tests do.
    expect(await lint(probe, "packages/shared/src/retirement/__fixture__.test.ts")).toEqual([]);
  }, 60_000);

  it("contracts-06: no source file of the engine imports a test framework (vitest is refused outside *.test.ts)", async () => {
    const code = 'import { expect } from "vitest";\nexport const x = expect;\n';
    for (const path of ["packages/retirement/src/__fixture__.ts", "packages/retirement/src/node/__fixture__.ts", "packages/retirement/src/testing/__fixture__.ts"]) {
      expect((await lint(code, path)).filter((m) => m.startsWith("no-restricted-imports")), path).toHaveLength(1);
    }
    expect(await lint(code, "packages/retirement/src/__fixture__.test.ts")).toEqual([]);
  }, 60_000);

  it("T46 keeps node: imports, process and performance out of the core but allows them in src/node", async () => {
    const io = 'import { cpus } from "node:os";\nexport const n = cpus().length + Number(process.env.N) + performance.now();\n';
    const core = await lint(io, "packages/retirement/src/__fixture__.ts");
    expect(core.filter((m) => m.startsWith("no-restricted-imports"))).toHaveLength(1);
    expect(core.filter((m) => m.startsWith("no-restricted-globals"))).toHaveLength(2);
    expect(await lint(io, "packages/retirement/src/node/__fixture__.ts")).toEqual([]);
  }, 60_000);

  it("T46 test files may compare against Math.exp", async () => {
    expect(await lint(fixture, "packages/retirement/src/__fixture__.test.ts")).toEqual([]);
  }, 60_000);
});
