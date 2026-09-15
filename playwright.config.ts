import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:3107', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'node dist/server/main.js',
    url: 'http://127.0.0.1:3107/api/health',
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'test',
      DEV_AUTH: 'true',
      HOST: '127.0.0.1',
      PORT: '3107',
      DATA_DIR: './data/e2e',
      WORKER_ENABLED: 'false',
      SESSION_SECRET: 'e2e-local-secret-not-a-production-secret',
      BOT_TOKEN: '',
      OPENAI_API_KEY: '',
    },
  },
});
