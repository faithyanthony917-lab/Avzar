import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  // tsconfig says jsx: "preserve" (Next compiles the JSX), so tell the test transform to compile it itself.
  // Component tests opt in to a browser-like environment with a "// @vitest-environment jsdom" first line;
  // every other test keeps running in plain Node.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // The app's unit tests live beside the pure view-model/helpers under src.
    // Keep the legacy test/ directory enabled for older suites as well.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts', 'test/**/*.test.tsx'],
    coverage: { reporter: ['text', 'html'], include: ['src/lib/**/*.ts'] },
  },
});
