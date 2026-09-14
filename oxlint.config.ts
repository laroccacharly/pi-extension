import { defineConfig } from "oxlint"
import core from "ultracite/oxlint/core"

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  options: {
    typeAware: true,
    typeCheck: true,
  },
  rules: {
    complexity: ["error", 15],
    "func-style": "off",
    "max-classes-per-file": "off",
    "max-depth": ["error", { max: 3 }],
    "no-await-in-loop": "off",
    "no-promise-executor-return": "off",
    "sort-keys": "off",
    "typescript/consistent-return": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "unicorn/import-style": "off",
    "unicorn/throw-new-error": "off",
    "promise/avoid-new": "off",
  },
})
