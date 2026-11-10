import { defineConfig } from 'vitest/config';

const engineSource = new URL('../engine/src/index.ts', import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: [{ find: /^@raf\/engine$/, replacement: engineSource }],
  },
});
