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

const BANNED_MATH = new Set([
  "exp", "log", "log2", "log10", "log1p", "expm1", "pow",
  "sin", "cos", "tan", "sinh", "cosh", "tanh", "atan", "atan2", "cbrt", "hypot", "random",
]);

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE_FILE = /\.(ts|mts|cts|js|mjs|cjs)$/;

interface Finding {
  line: number;
  what: string;
}

function isMath(node: ts.Node): boolean {
  return ts.isIdentifier(node) && node.text === "Math";
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
    if (ts.isPropertyAccessExpression(node) && isMath(node.expression) && BANNED_MATH.has(node.name.text)) {
      add(node, `Math.${node.name.text}`);
    } else if (
      ts.isElementAccessExpression(node) &&
      isMath(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      BANNED_MATH.has(node.argumentExpression.text)
    ) {
      add(node, `Math["${node.argumentExpression.text}"]`);
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isMath(node.initializer)) {
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && BANNED_MATH.has(key.text)) add(el, `{ ${key.text} } = Math`);
      }
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
        node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)
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

/** Engine source files: everything under src/ except tests. */
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

  it("T46 the scan fails on a fixture containing Math.exp(", () => {
    expect(scanSource("export const e = Math.exp(1);\n")).toEqual([{ line: 1, what: "Math.exp" }]);
  });

  it("T46 the scan fails on a fixture containing **", () => {
    expect(scanSource("const a = 2;\nexport const b = a ** 0.5;\n")).toEqual([{ line: 2, what: "**" }]);
    expect(scanSource("let a = 2;\na **= 3;\n")).toEqual([{ line: 2, what: "**=" }]);
  });

  it("T46 the scan catches every banned name and the indirect forms", () => {
    for (const name of BANNED_MATH) expect(scanSource(`Math.${name}(0.5);`)).toHaveLength(1);
    expect(scanSource(`const x = Math["pow"](2, 3);`)).toEqual([{ line: 1, what: 'Math["pow"]' }]);
    expect(scanSource(`const { log: ln, sqrt } = Math;`)).toEqual([{ line: 1, what: "{ log } = Math" }]);
    expect(scanSource(`const t = Date.now();\nconst d = new Date();`)).toEqual([
      { line: 1, what: "Date" },
      { line: 2, what: "Date" },
    ]);
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
    expect(core.filter((m) => m.startsWith("no-restricted-properties"))).toHaveLength(2);
    expect(core.filter((m) => m.startsWith("no-restricted-syntax"))).toHaveLength(1);
    expect(core.filter((m) => m.startsWith("no-restricted-globals"))).toHaveLength(1);
    const harness = await lint(fixture, "packages/retirement/src/node/__fixture__.ts");
    expect(harness).toHaveLength(4);
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
