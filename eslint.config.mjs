import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  // tests/e2e holds Playwright specs for a runner not yet installed in this
  // repo (see docs/superpowers/plans/2026-08-18-b2c-single-control-flow.md,
  // Task 7); it is not part of the app's TypeScript/ESLint project.
  { ignores: ["tests/e2e/**"] },
  ...compat.extends("next/core-web-vitals"),
];
