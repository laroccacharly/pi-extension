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
    complexity: ["warn", 10],
    "func-style": "off",
    "max-classes-per-file": "off",
    "max-depth": ["error", { max: 3 }],
    "max-lines-per-function": [
      "warn",
      { max: 60, skipBlankLines: true, skipComments: true },
    ],
    "max-params": ["warn", 3],
    "no-await-in-loop": "off",
    "no-promise-executor-return": "off",
    "sort-keys": "off",
    "typescript/consistent-return": "off",
    "typescript/no-floating-promises": [
      "error",
      // `void` marks deliberate background work; still reject bare floating promises.
      { ignoreIIFE: false, ignoreVoid: true },
    ],
    "typescript/no-unsafe-type-assertion": "warn",
    "unicorn/import-style": "off",
    "unicorn/throw-new-error": "off",
    "promise/avoid-new": "off",
  },
})
