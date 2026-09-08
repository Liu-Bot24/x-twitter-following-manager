# Tests

Use Node.js 22 or later:

```powershell
npm ci
npx playwright install chromium
npm test
```

`npm run test:core` runs the data, import/export, storage-service and network contract tests without launching a browser.

`npm test` also launches isolated Chromium fixtures and loads the real unpacked Manifest V3 extension. Browser profiles are created under ignored `test-results/`; the tests use synthetic X pages and synthetic account data, not your everyday browser profile.

To use an existing compatible Chromium build, set its executable path before running the tests:

```powershell
$env:XFS_CHROMIUM = 'C:\path\to\chromium\chrome.exe'
npm test
```

The browser tests cover native-node preservation, idle DOM behavior, profile/hover identity, viewport gating, real extension injection, concurrent manager imports, pagination, storage failure UI, temporary locks and clear generations. They do not establish compatibility with every future X DOM/API change or replace a check on a logged-in live X page.
