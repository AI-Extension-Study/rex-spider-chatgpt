import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  { files: ["**/*.{js,mjs,cjs,ts,mts,cts}"], plugins: { js }, extends: ["js/recommended"], languageOptions: { globals: globals.browser } },
  tseslint.configs.recommended,
  // Node strips types without reading other files, so an import used only as
  // a type has to say so, or Node looks for a value that is not exported.
  { files: ["**/*.{ts,mts,cts}"], rules: { "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }] } },
  { files: ["tests/unit/**/*"], languageOptions: { globals: globals.node } },
]);
