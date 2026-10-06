import { defineConfig, devices } from '@playwright/test';

const PORT = 4174;
// Local sandboxes may ship a different Chromium; point PW_CHROMIUM_PATH at it. CI installs its own.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}/arena/`, acceptDownloads: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(executablePath ? { launchOptions: { executablePath } } : {}) } }],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/arena/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
