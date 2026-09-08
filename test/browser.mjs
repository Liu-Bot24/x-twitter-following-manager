import { createRequire } from 'node:module';
export const { chromium } = createRequire(import.meta.url)('playwright');
export const browserOptions = {
  headless: true,
  ...(process.env.XFS_CHROMIUM ? { executablePath: process.env.XFS_CHROMIUM } : { channel: process.env.XFS_BROWSER_CHANNEL || 'chromium' })
};
