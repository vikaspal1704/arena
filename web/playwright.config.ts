import { defineConfig, devices } from '@playwright/test';

const PORT = 4174;
export const MOCK_BRIDGE = 8799;
export const BARE_BRIDGE = 8798;
// Local sandboxes may ship a different Chromium; point PW_CHROMIUM_PATH at it. CI installs its own.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}/arena/`, acceptDownloads: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(executablePath ? { launchOptions: { executablePath } } : {}) } }],
  webServer: [
    {
      command: `npx vite preview --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}/arena/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    // Real-market mode: the local bridge with mock ticks, serving the same build.
    {
      command: `node ../bridge/src/server.mjs --mock --port=${MOCK_BRIDGE}`,
      url: `http://127.0.0.1:${MOCK_BRIDGE}/arena/`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    // A bridge with no Kite credentials, to check the setup screen.
    {
      command: `node ../bridge/src/server.mjs --port=${BARE_BRIDGE}`,
      url: `http://127.0.0.1:${BARE_BRIDGE}/arena/`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { KITE_API_KEY: '', KITE_API_SECRET: '' },
    },
  ],
});
