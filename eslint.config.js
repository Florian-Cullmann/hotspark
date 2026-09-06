import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  {
    ignores: ["dist/**", "node_modules/**", "**/.next/**", "**/next-env.d.ts"],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
);
