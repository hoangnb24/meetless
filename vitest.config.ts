import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "react-native": path.join(root, "test/support/react-native.ts") },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts", "packages/**/test/**/*.test.tsx", "test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
