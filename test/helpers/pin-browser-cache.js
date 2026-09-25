// CLI tests isolate HOME to keep real credentials out. Keep the browser
// installation outside those disposable homes, without weakening preflight.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  try {
    const executable = require('playwright').chromium.executablePath();
    process.env.PLAYWRIGHT_BROWSERS_PATH = executable.split(/[/\\]chromium-\d+[/\\]/)[0];
  } catch { /* A missing browser must still fail the real CLI checks. */ }
}
