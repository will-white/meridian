import { builtinModules } from "node:module";
import tseslint from "typescript-eslint";

// Retirement engine determinism (docs/design/phase-4/engine-and-returns.md §3.14, decision 21).
// ECMAScript fixes + − × ÷ and Math.sqrt/floor/round/abs/min/max/imul exactly; it leaves these
// implementation-approximated, so their last bit can change with the CPU, Node or the browser.
// The engine uses detExp/detLog/detPow/powInt (packages/retirement/src/detmath.ts) instead.
// packages/retirement/src/determinism.test.ts scans the package for the same list.
const RETIREMENT_SRC = "packages/retirement/src/**/*.{ts,mts,js,mjs}";
const RETIREMENT_TESTS = "packages/retirement/src/**/*.test.ts";
const NON_DETERMINISTIC_MATH = [
  "exp", "log", "log2", "log10", "log1p", "expm1", "pow",
  "sin", "cos", "tan", "sinh", "cosh", "tanh", "atan", "atan2", "cbrt", "hypot", "random",
];
const mathMessage = "is not deterministic across platforms; use detExp, detLog, detPow or powInt from detmath.ts.";
const randomMessage = "Math.random is not seeded; every draw comes from the counter-based generator (rng.ts).";
const dateMessage = "The engine has no clock: dates come from SimInput.plan, elapsed time from performance.now() in src/node.";
const coreMessage = "Only packages/retirement/src/node may do I/O or read the clock or the environment.";

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
    // The whole engine package, the thread harness included (tests may compare against Math.exp).
    files: [RETIREMENT_SRC],
    ignores: [RETIREMENT_TESTS],
    rules: {
      "no-restricted-properties": [
        "error",
        ...NON_DETERMINISTIC_MATH.map((property) => ({
          object: "Math",
          property,
          message: property === "random" ? randomMessage : `Math.${property} ${mathMessage}`,
        })),
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "BinaryExpression[operator='**']", message: `The ** operator ${mathMessage}` },
        { selector: "AssignmentExpression[operator='**=']", message: `The **= operator ${mathMessage}` },
      ],
      "no-restricted-globals": ["error", { name: "Date", message: dateMessage }],
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
          paths: builtinModules.map((name) => ({ name, message: coreMessage })),
          patterns: [{ group: ["node:*"], message: coreMessage }],
        },
      ],
    },
  },
);
