import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several tests start real processes (fake wacli and agy scripts), which can be slow on a busy machine.
    testTimeout: 15_000,
  },
});
