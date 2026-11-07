import node from "@burdenoff/toolchain/eslint/node";

// The toolchain Node profile (typescript-eslint recommended, no Prettier
// plugin) plus the three rules @eslint/js 10's recommended set added, so the
// effective rule set matches the previous @eslint/js 10 + typescript-eslint
// config exactly.
export default node({
  globals: { Bun: "readonly" },
  rules: {
    "no-unassigned-vars": "error",
    "no-useless-assignment": "error",
    "preserve-caught-error": ["error", { requireCatchParameter: false }],
  },
});
