import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// `base` matches the GitHub Pages project path.
export default defineConfig({
  base: '/arena/',
  plugins: [react()],
  worker: { format: 'es' },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
