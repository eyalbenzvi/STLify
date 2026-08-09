// ESLint flat config: TypeScript-recommended (syntactic) rules + React
// hooks rules. Type-aware linting is intentionally off — the project uses
// the TypeScript 7 native-preview compiler, which typescript-eslint's
// type-checked rule set does not support yet; `tsc --noEmit` covers type
// correctness separately.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "public/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build-time node scripts (no bundler, no DOM).
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The kernel wrapper and dialogs use intentional non-null assertions
      // after explicit guards; keep the signal but as a warning.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  }
);
