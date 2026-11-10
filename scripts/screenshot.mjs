// Takes docs/screenshot.png for the README: the Invalid story of the e2e fixture with validation
// on and the Mokapi panel showing the validation error. Needs a fresh `npm run build` and a Mokapi
// with the validate endpoint (MOKAPI_BIN, otherwise the go-mokapi package).
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const fixtureDirectory = fileURLToPath(new URL('../tests/e2e/fixture/', import.meta.url));
const screenshotFile = fileURLToPath(new URL('../docs/screenshot.png', import.meta.url));

async function unusedPorts(count) {
  const servers = Array.from({ length: count }, () => createServer());
  await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  })));
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

function mokapiBinary() {
  if (process.env.MOKAPI_BIN) return process.env.MOKAPI_BIN;
  const mokapiRequire = createRequire(require.resolve('go-mokapi/package.json'));
  return mokapiRequire(`@go-mokapi/${process.platform}-${process.arch}`);
}

async function waitUntil(isReady, what, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      if (await isReady()) return;
    } catch { /* not ready yet */ }
    if (Date.now() >= deadline) throw new Error(`${what} did not start within ${timeout / 1000} s`);
    await setTimeout(500);
  }
}

const directory = await mkdtemp(join(tmpdir(), 'mokapi-storybook-screenshot-'));
const stops = [];
try {
  const [apiPort, dashboardPort, storybookPort] = await unusedPorts(3);
  const dashboard = `http://localhost:${dashboardPort}`;
  const storybook = `http://localhost:${storybookPort}`;

  // Mokapi takes the HTTP port from the servers URL.
  const contract = JSON.parse(await readFile(join(fixtureDirectory, 'openapi.json'), 'utf8'));
  contract.servers = [{ url: `http://localhost:${apiPort}` }];
  await writeFile(join(directory, 'openapi.json'), JSON.stringify(contract));
  await writeFile(join(directory, 'mokapi.yaml'), `api:
  port: ${dashboardPort}
health:
  enabled: false
mcp:
  server:
    enabled: false
providers:
  file:
    filenames:
      - ${join(directory, 'openapi.json')}
`);
  // Mokapi rejects unknown MOKAPI_* environment variables, so MOKAPI_BIN must not reach it.
  const mokapiEnv = { ...process.env };
  delete mokapiEnv.MOKAPI_BIN;
  const mokapi = spawn(mokapiBinary(), [], { cwd: directory, env: mokapiEnv, stdio: 'ignore' });
  stops.push(() => mokapi.kill('SIGTERM'));
  await waitUntil(async () => (await fetch(`${dashboard}/api/info`)).ok, 'Mokapi');

  // Storybook starts child processes, so it runs in its own process group and the group is stopped.
  const cli = join(dirname(require.resolve('storybook/package.json')), 'dist/bin/dispatcher.js');
  const storybookProcess = spawn(process.execPath, [
    cli, 'dev', '--ci', '--port', String(storybookPort), '--exact-port', '--no-open', '--disable-telemetry',
    '--config-dir', join(fixtureDirectory, '.storybook'),
  ], {
    cwd: fixtureDirectory,
    env: { ...process.env, MOKAPI_DASHBOARD: dashboard, MOKAPI_DEFAULT_VALIDATION: 'true', STORYBOOK_DISABLE_TELEMETRY: '1' },
    detached: true,
    stdio: 'ignore',
  });
  stops.push(() => process.kill(-storybookProcess.pid, 'SIGTERM'));
  await waitUntil(async () => (await fetch(`${storybook}/index.json`)).ok, 'Storybook');

  const browser = await chromium.launch();
  stops.push(() => browser.close());

  // The first load makes Vite optimize dependencies and reload. It uses its own page: MSW's service
  // worker unregisters when its last client closes, so a navigated warm-up page would stay unmocked.
  const warmUp = await browser.newPage();
  await warmUp.goto(`${storybook}/iframe.html?id=profile--valid&viewMode=story`);
  await warmUp.getByText('Jane Doe').waitFor({ timeout: 120000 });
  await warmUp.close();

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await page.goto(`${storybook}/?path=/story/profile--invalid`);
  await page.getByRole('tab', { name: /^Mokapi/ }).click();
  await page.locator('[data-testid="mokapi-entry"][data-status="invalid"]').first().waitFor({ timeout: 30000 });
  // Storybook's "What's new" notification would cover the sidebar.
  const dismiss = page.getByRole('button', { name: 'Dismiss notification' });
  while (await dismiss.count() > 0) await dismiss.first().click();
  await setTimeout(500);
  await page.screenshot({ path: screenshotFile });
  console.log(`Saved ${screenshotFile}`);
} finally {
  for (const stop of stops.reverse()) {
    try { await stop(); } catch { /* already stopped */ }
  }
  await rm(directory, { recursive: true, force: true });
}
