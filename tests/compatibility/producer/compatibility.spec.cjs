const http = require('http');
const { test, expect } = require('@playwright/test');

const LARGE_MARKER = `PWTR_LARGE_BODY:${'x'.repeat(34 * 1024)}`;
let server;
let baseUrl;

function htmlPage() {
  return `<!doctype html>
    <html>
      <body>
        <main automation-id="pwtr-main">
          <h1>PWTR_REAL_DOM_MARKER</h1>
          <button automation-id="pwtr-browser-request">Run browser request</button>
          <output automation-id="pwtr-browser-result">idle</output>
          <iframe automation-id="pwtr-frame" src="/frame"></iframe>
        </main>
        <script>
          console.warn('PWTR_CONSOLE_WARNING');
          console.error('PWTR_CONSOLE_ERROR');
          setTimeout(() => { throw new Error('PWTR_PAGE_ERROR'); }, 0);
          document.querySelector('[automation-id="pwtr-browser-request"]').addEventListener('click', async () => {
            const response = await fetch('/browser-failure');
            document.querySelector('[automation-id="pwtr-browser-result"]').textContent =
              response.status + ':' + await response.text();
          });
        </script>
      </body>
    </html>`;
}

function framePage() {
  return `<!doctype html><html><body>
    <button automation-id="pwtr-frame-button" onclick="this.textContent='PWTR_IFRAME_CLICKED'">PWTR_IFRAME_MARKER</button>
  </body></html>`;
}

test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const chunks = [];
    for await (const chunk of request)
      chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');

    if (url.pathname === '/') {
      response.setHeader('content-type', 'text/html');
      response.end(htmlPage());
      return;
    }
    if (url.pathname === '/frame') {
      response.setHeader('content-type', 'text/html');
      response.end(framePage());
      return;
    }
    if (url.pathname === '/browser-failure') {
      response.statusCode = 503;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ marker: 'PWTR_BROWSER_FAILURE' }));
      return;
    }
    if (url.pathname === '/api-success') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ marker: 'PWTR_API_SUCCESS', body: LARGE_MARKER }));
      return;
    }
    if (url.pathname === '/api-failure') {
      response.statusCode = 422;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ marker: 'PWTR_API_FAILURE', requestBody: body }));
      return;
    }

    response.statusCode = 404;
    response.end('PWTR_NOT_FOUND');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not determine compatibility server address.');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('PWTR rich passing trace', async ({ page, request }, testInfo) => {
  console.log('PWTR_STDOUT_MARKER');
  console.error('PWTR_STDERR_MARKER');
  await testInfo.attach('pwtr-attachment.txt', {
    body: Buffer.from('PWTR_ATTACHMENT_MARKER\n'),
    contentType: 'text/plain',
  });

  await test.step('PWTR_STEP_NAVIGATE', async () => {
    await page.goto(baseUrl);
    await expect(page.locator('[automation-id="pwtr-main"]')).toContainText('PWTR_REAL_DOM_MARKER');
  });

  await test.step('PWTR_STEP_IFRAME', async () => {
    const frameButton = page.frameLocator('[automation-id="pwtr-frame"]').locator('[automation-id="pwtr-frame-button"]');
    await frameButton.click();
    await expect(frameButton).toHaveText('PWTR_IFRAME_CLICKED');
  });

  await test.step('PWTR_STEP_BROWSER_NETWORK', async () => {
    await page.locator('[automation-id="pwtr-browser-request"]').click();
    await expect(page.locator('[automation-id="pwtr-browser-result"]')).toContainText('503:');
  });

  await test.step('PWTR_STEP_API_NETWORK', async () => {
    const success = await request.get(`${baseUrl}/api-success`);
    expect(await success.text()).toContain('PWTR_LARGE_BODY');
    const failure = await request.post(`${baseUrl}/api-failure`, {
      data: { marker: 'PWTR_API_REQUEST_BODY' },
    });
    expect(failure.status()).toBe(422);
    expect(await failure.text()).toContain('PWTR_API_FAILURE');
  });
});

test('PWTR deterministic failure', async ({ page }) => {
  await page.goto(baseUrl);
  await test.step('PWTR_STEP_ALWAYS_FAILS', async () => {
    expect('PWTR_ACTUAL_FAILURE').toBe('PWTR_EXPECTED_FAILURE');
  });
});

test('PWTR deterministic flaky', async ({ page }, testInfo) => {
  await page.goto(baseUrl);
  await test.step('PWTR_STEP_FLAKY', async () => {
    expect(testInfo.retry).toBe(1);
  });
});

test('PWTR API-only trace', async ({ request }) => {
  const response = await request.post(`${baseUrl}/api-failure`, {
    data: { marker: 'PWTR_API_ONLY_REQUEST' },
  });
  expect(response.status()).toBe(422);
  expect(await response.text()).toContain('PWTR_API_ONLY_REQUEST');
});