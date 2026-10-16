import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["packages/{contracts,platform-client,platform-host,adapters/opencode}/tests/**/*.test.ts"], testTimeout: 15_000, pool: "forks", maxWorkers: 2, minWorkers: 1 },
});
