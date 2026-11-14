import { builtinModules } from "node:module";
import tseslint from "typescript-eslint";

// Retirement engine determinism (docs/design/phase-4/engine-and-returns.md §3.14, decision 21).
// ECMAScript fixes + − × ÷ and Math.sqrt/floor/ceil/trunc/round/abs/min/max/imul/sign/fround
// exactly; every other Math function (exp, log, pow, the trigonometric and hyperbolic functions and
// their inverses, cbrt, hypot, …) is implementation-approximated, so its last bit can change with
// the CPU, Node or the browser, and Math.random is not seeded. The rule is therefore an allow-list:
// any other Math member, a computed member, an alias of Math and the global object's Math or Date
// are refused. The engine uses detExp/detLog/detPow/powInt (packages/retirement/src/detmath.ts)
// and the counter-based generator (rng.ts) instead. The same rule covers the shared retirement
// code the engine runs. packages/retirement/src/determinism.test.ts scans for the same rule.
const RETIREMENT_SRC = "packages/retirement/src/**/*.{ts,mts,js,mjs}";
const RETIREMENT_TESTS = "packages/retirement/src/**/*.test.ts";
const SHARED_RETIREMENT_SRC = "packages/shared/src/retirement/**/*.ts";
const SHARED_RETIREMENT_TESTS = "packages/shared/src/retirement/**/*.test.ts";
const EXACT_MATH = "sqrt|floor|ceil|trunc|round|abs|min|max|imul|sign|fround";
const mathMessage =
  `Only Math.{${EXACT_MATH.replaceAll("|", ",")}} are exact on every platform; use detExp, detLog, detPow or powInt from detmath.ts, ` +
  "and the counter-based generator (rng.ts) for random numbers.";
const dateMessage = "The engine has no clock: dates come from SimInput.plan, elapsed time from performance.now() in src/node.";
const coreMessage = "Only packages/retirement/src/node may do I/O or read the clock or the environment.";
const testFrameworkMessage = "Only *.test.ts files may import a test framework; the engine depends on @meridian/shared and zod only (seams §2.1).";
/** `**` is exact only on bigints: allowed when an operand holds a bigint literal or a BigInt() call (mixing bigint and number throws). */
const powSelector = (operator) =>
  `${operator === "**" ? "BinaryExpression" : "AssignmentExpression"}[operator='${operator}']:not(:has(Literal[bigint])):not(:has(CallExpression[callee.name='BigInt']))`;
const DETERMINISM_SYNTAX = [
  { selector: powSelector("**"), message: `The ** operator is not exact on numbers. ${mathMessage}` },
  { selector: powSelector("**="), message: `The **= operator is not exact on numbers. ${mathMessage}` },
  { selector: `MemberExpression[object.name='Math'][computed=false]:not([property.name=/^(${EXACT_MATH})$/])`, message: mathMessage },
  { selector: "MemberExpression[object.name='Math'][computed=true]", message: `A computed member of Math cannot be checked. ${mathMessage}` },
  { selector: "MemberExpression[object.name=/^(globalThis|window|self|global)$/]:matches([property.name=/^(Math|Date)$/], [computed=true])", message: `The global object's Math and Date are the same objects. ${mathMessage}` },
  {
    selector:
      "Identifier[name='Math']:not(MemberExpression > Identifier.object):not(MemberExpression[computed=false] > Identifier.property)" +
      ":not(Property > Identifier.key):not(VariableDeclarator[id.type='ObjectPattern'] > Identifier.init):not(TSQualifiedName > Identifier):not(TSTypeQuery > Identifier)",
    message: `An alias of Math hides which functions are used. ${mathMessage}`,
  },
  {
    selector: `VariableDeclarator[init.name='Math'] > ObjectPattern > Property:not([key.name=/^(${EXACT_MATH})$/])`,
    message: mathMessage,
  },
];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/drizzle/**", "**/dev-dist/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // The whole engine package, the thread harness included (tests may compare against Math.exp),
    // and the shared retirement code the engine runs (vpwRawPercentageInto, glideWeightsAt,
    // rankPaths, addUp, …).
    files: [RETIREMENT_SRC, SHARED_RETIREMENT_SRC],
    ignores: [RETIREMENT_TESTS, SHARED_RETIREMENT_TESTS],
    rules: {
      "no-restricted-syntax": ["error", ...DETERMINISM_SYNTAX],
      "no-restricted-globals": ["error", { name: "Date", message: dateMessage }],
    },
  },
  {
    // The engine package's sources import no test framework.
    files: [RETIREMENT_SRC],
    ignores: [RETIREMENT_TESTS],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "vitest", message: testFrameworkMessage }], patterns: [{ group: ["vitest/*", "@vitest/*"], message: testFrameworkMessage }] }],
    },
  },
  {
    // The pure core: everything except the thread harness in src/node.
    files: [RETIREMENT_SRC],
    ignores: [RETIREMENT_TESTS, "packages/retirement/src/node/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "Date", message: dateMessage },
        { name: "performance", message: coreMessage },
        { name: "process", message: coreMessage },
        { name: "crypto", message: coreMessage },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [...builtinModules.map((name) => ({ name, message: coreMessage })), { name: "vitest", message: testFrameworkMessage }],
          patterns: [
            { group: ["node:*"], message: coreMessage },
            { group: ["vitest/*", "@vitest/*"], message: testFrameworkMessage },
          ],
        },
      ],
    },
  },
);
