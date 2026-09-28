import { defineConfig } from "vitest/config"

// unit tests for pure modules only — no Vite app plugins (router codegen,
// tailwind), no DOM. Component behaviour is verified in the browser.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
