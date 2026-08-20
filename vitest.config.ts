import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    // tests/e2e holds Playwright specs (a separate, not-yet-installed runner);
    // Vitest's default *.spec.ts pattern would otherwise try to run them too.
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
});
