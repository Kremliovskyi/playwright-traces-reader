const path = require('path');

const outputRoot = process.env.PWTR_COMPAT_OUTPUT;
if (!outputRoot)
  throw new Error('PWTR_COMPAT_OUTPUT is required.');

module.exports = {
  testDir: __dirname,
  testMatch: 'compatibility.spec.cjs',
  workers: 1,
  retries: 1,
  outputDir: path.join(outputRoot, 'test-results'),
  use: {
    trace: {
      mode: 'on',
      screenshots: true,
      snapshots: true,
      sources: false,
      attachments: true,
    },
  },
  reporter: [
    ['html', { outputFolder: path.join(outputRoot, 'playwright-report'), open: 'never' }],
    ['json', { outputFile: path.join(outputRoot, 'results.json') }],
  ],
};