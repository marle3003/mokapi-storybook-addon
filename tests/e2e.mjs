import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { chromium } from 'playwright';

const fixtureDirectory = fileURLToPath(new URL('./e2e/fixture/', import.meta.url));
const require = createRequire(import.meta.url);

const API_TITLE = 'Profile API';
const SCENARIO_PARAMETER = '__mockScenario';
const BACKEND_TITLES = { msw: 'MSW (browser)', mokapi: 'Mokapi (OpenAPI validation)' };

// Returns count distinct free ports. All servers stay open until every port is
// allocated, otherwise the OS may hand out the same port twice.
async function unusedPorts(count) {
  const servers = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.filter((server) => server.listening).map((server) =>
      new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  }
}

// Absolute filenames, because the mock script and the OpenAPI file live in different directories.
const mokapiConfig = (dashboardPort, filenames) => `api:
  port: ${dashboardPort}
health:
  enabled: false
mcp:
  server:
    enabled: false
providers:
  file:
    filenames:
${filenames.map((filename) => `      - ${filename}`).join('\n')}
javascript:
  modules:
    aliases:
      msw: mokapi-msw-adapter
`;

const getJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 200, url);
  return response.json();
};

// Retries assertion until it passes or the timeout is over, then throws its last error.
async function eventually(assertion, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      return await assertion();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await setTimeout(100);
    }
  }
}

// Starts Mokapi in directory and waits until isReady() passes, i.e. the mock script has registered.
async function startMokapi(directory, isReady) {
  const mokapiRequire = createRequire(require.resolve('go-mokapi/package.json'));
  const binary = mokapiRequire(`@go-mokapi/${process.platform}-${process.arch}`);
  const child = spawn(binary, [], { cwd: directory, stdio: 'inherit' });
  let startupError;
  child.on('error', (error) => { startupError = error; });
  const stopped = new Promise((resolve) => {
    child.once('error', resolve);
    child.once('exit', resolve);
  });
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await stopped;
  };
  const deadline = Date.now() + 15000;
  while (true) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`Mokapi exited with code ${child.exitCode}`);
    try {
      await isReady();
      return stop;
    } catch (error) {
      if (Date.now() >= deadline) {
        await stop();
        throw new Error('Mokapi startup failed', { cause: error });
      }
      await setTimeout(100);
    }
  }
}

// Storybook starts child processes, so it runs in its own process group (POSIX only)
// and the whole group is stopped. Otherwise they would keep the port open.
async function startStorybook({ port, env, browser }) {
  const cli = join(dirname(require.resolve('storybook/package.json')), 'dist/bin/dispatcher.js');
  const child = spawn(process.execPath, [
    cli, 'dev', '--ci', '--port', String(port), '--exact-port', '--no-open', '--disable-telemetry',
    '--config-dir', join(fixtureDirectory, '.storybook'),
  ], {
    cwd: fixtureDirectory,
    env: { ...process.env, ...env, STORYBOOK_DISABLE_TELEMETRY: '1' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; });
  let startupError;
  child.on('error', (error) => { startupError = error; });
  const stopped = new Promise((resolve) => {
    child.once('error', resolve);
    child.once('exit', resolve);
  });
  const killGroup = (signal) => {
    try { process.kill(-child.pid, signal); } catch { /* the group is already gone */ }
  };
  const stop = async () => {
    killGroup('SIGTERM');
    await Promise.race([stopped, setTimeout(5000)]);
    killGroup('SIGKILL');
  };
  const fail = async (message, cause) => {
    await stop();
    throw new Error(`${message}\n${output.slice(-4000)}`, { cause });
  };

  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 120000;
  while (true) {
    if (startupError) await fail('Storybook could not be started', startupError);
    if (child.exitCode !== null) await fail(`Storybook exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/index.json`, { signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200);
      break;
    } catch (error) {
      if (Date.now() >= deadline) await fail('Storybook startup failed', error);
      await setTimeout(500);
    }
  }
  // The first page load makes Vite optimize dependencies and reload; do that before the tests.
  try {
    const page = await browser.newPage();
    try {
      await page.goto(`${url}/iframe.html?id=profile--success&viewMode=story`);
      await page.getByTestId('profile').waitFor({ timeout: Math.max(1000, deadline - Date.now()) });
    } finally {
      await page.close();
    }
  } catch (error) {
    await fail('Storybook warm-up failed', error);
  }
  return { url, stop };
}

const TOOLBAR_LABEL = 'Execute shared mocks in MSW or validate them with Mokapi';
const toolbarButton = (page) => page.getByRole('button', { name: TOOLBAR_LABEL });

async function switchBackend(page, backend) {
  await toolbarButton(page).click();
  await page.getByRole('option', { name: BACKEND_TITLES[backend] }).click();
  // The toolbar title follows the selection; the preview iframe reloads after that.
  await page.getByRole('button', {
    name: `${TOOLBAR_LABEL} ${BACKEND_TITLES[backend]}`,
    exact: true,
  }).waitFor();
}

// Opens a story or docs page like a Storybook user (MSW is the default) and optionally switches the backend.
async function openStory(page, storybookUrl, { id, docs = false, backend = 'msw' }) {
  await page.goto(`${storybookUrl}/?path=/${docs ? 'docs' : 'story'}/${id}`);
  await toolbarButton(page).waitFor();
  if (backend !== 'msw') await switchBackend(page, backend);
}

const previewFrame = (page) => page.frameLocator('#storybook-preview-iframe');
const profileInPreview = (page) => previewFrame(page).getByTestId('profile');
const profileInDocsStory = (page, storyId) =>
  previewFrame(page).frameLocator(`#iframe--${storyId}`).first().getByTestId('profile');

const showsText = (locator, text) => eventually(async () =>
  assert.equal(await locator.textContent({ timeout: 1000 }), text));

const openMokapiPanel = (page) => page.getByRole('tab', { name: 'Mokapi' }).click();

// Expands the newest request with the given status code and returns its open disclosure.
// The panel polls and inserts newer requests at the top, so the result is scoped to the open entry.
async function openRequest(page, statusCode) {
  const summary = page.getByText(new RegExp(`^${statusCode} \\| GET /api/profile`));
  await summary.first().click();
  return page.locator('details[open]').filter({ has: summary }).first();
}

// Expands the nested disclosure with the given title inside a request and returns it.
async function openDetails(request, title) {
  const details = request.locator('details').filter({ has: request.page().getByText(title, { exact: true }) });
  await details.getByText(title, { exact: true }).click();
  return details;
}

test('Storybook user switches stories between MSW and Mokapi and inspects the requests', { timeout: 300000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mokapi-storybook-e2e-'));
  let failureDirectory;
  let stopMokapi;
  let browser;
  let storybook;
  try {
    const [apiPort, dashboardPort, storybookPort] = await unusedPorts(3);
    const api = `http://localhost:${apiPort}`;
    const dashboard = `http://localhost:${dashboardPort}`;

    const contract = JSON.parse(await readFile(join(fixtureDirectory, 'openapi.json'), 'utf8'));
    contract.servers = [{ url: api }];
    await writeFile(join(directory, 'openapi.json'), JSON.stringify(contract));
    await writeFile(join(directory, 'mokapi.yaml'), mokapiConfig(dashboardPort, [
      join(directory, 'openapi.json'),
      join(fixtureDirectory, 'mocks/profile.js'),
    ]));

    stopMokapi = await startMokapi(directory, async () => {
      assert.equal((await fetch(`${api}/api/profile?${SCENARIO_PARAMETER}=success`)).status, 200);
      await getJson(`${dashboard}/api/info`);
    });

    // Requests Mokapi received for the scenario, from the dashboard API the request panel uses.
    const profileRequests = async (scenario) => {
      const query = new URLSearchParams({
        'traits[namespace]': 'http', 'traits[name]': API_TITLE, size: '100',
      });
      const { items } = await getJson(`${dashboard}/api/events?${query}`);
      return items.filter((event) =>
        new URL(event.data.request.url).searchParams.get(SCENARIO_PARAMETER) === scenario);
    };
    const requestCount = async (scenario) => (await profileRequests(scenario)).length;
    const waitForRequestAfter = (scenario, countBefore) => eventually(async () =>
      assert.ok(await requestCount(scenario) > countBefore, `Mokapi request for ${scenario}`));
    // Mokapi's readiness check already requested the success scenario once.
    const readinessRequests = await requestCount('success');

    browser = await chromium.launch();
    storybook = await startStorybook({
      port: storybookPort,
      env: { MOKAPI_TARGET: api, MOKAPI_DASHBOARD: dashboard },
      browser,
    });

    const keepFailureArtifacts = async (name, page, consoleLines) => {
      failureDirectory ??= await mkdtemp(join(tmpdir(), 'mokapi-storybook-e2e-failure-'));
      const file = join(failureDirectory, name.replace(/\W+/g, '-'));
      await page.screenshot({ path: `${file}.png`, fullPage: true }).catch(() => {});
      await writeFile(`${file}.console.log`, consoleLines.join('\n'));
    };

    // Each scenario runs in a fresh browser context, so that no state leaks between them.
    const scenario = (name, run) => t.test(name, async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const consoleLines = [];
      page.on('console', (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
      page.on('pageerror', (error) => consoleLines.push(`[pageerror] ${error.message}`));
      try {
        await run(page);
      } catch (error) {
        await keepFailureArtifacts(name, page, consoleLines);
        throw error;
      } finally {
        await context.close();
      }
    });
    const open = (page, options) => openStory(page, storybook.url, options);

    await scenario('MSW is the default: Success shows the MSW data and Mokapi receives no request', async (page) => {
      await open(page, { id: 'profile--success' });
      await showsText(profileInPreview(page), 'Jane Doe');
      assert.equal(await requestCount('success'), readinessRequests);
    });

    await scenario('switching the toolbar to Mokapi reloads the preview and sends the request to Mokapi', async (page) => {
      const before = await requestCount('success');
      await open(page, { id: 'profile--success' });
      await switchBackend(page, 'mokapi');
      await showsText(profileInPreview(page), 'Jane Doe');
      await waitForRequestAfter('success', before);
    });

    await scenario('switching back to MSW sends no further requests to Mokapi', async (page) => {
      const before = await requestCount('success');
      await open(page, { id: 'profile--success', backend: 'mokapi' });
      await waitForRequestAfter('success', before);
      await switchBackend(page, 'msw');
      await showsText(profileInPreview(page), 'Jane Doe');
      const afterSwitch = await requestCount('success');
      for (let i = 0; i < 5; i++) {
        await setTimeout(300);
        assert.equal(await requestCount('success'), afterSwitch);
      }
    });

    await scenario('Invalid shows the data in MSW mode and HTTP 500 in Mokapi mode', async (page) => {
      await open(page, { id: 'profile--invalid' });
      await showsText(profileInPreview(page), 'Jane Doe');
      await switchBackend(page, 'mokapi');
      await showsText(profileInPreview(page), 'HTTP 500');
    });

    await scenario('the panel asks to select Mokapi while MSW is active', async (page) => {
      await open(page, { id: 'profile--success' });
      await openMokapiPanel(page);
      await page.getByText('Select Mokapi in the toolbar to inspect request logs.').waitFor();
    });

    await scenario('the panel lists the story request with API, scenario and status in Mokapi mode', async (page) => {
      await open(page, { id: 'profile--success', backend: 'mokapi' });
      await openMokapiPanel(page);
      await page.getByText('API: Profile API | Scenario: success').waitFor();
      await page.getByText(/^200 \| GET \/api\/profile/).first().waitFor();
    });

    await scenario('the panel shows the executed script and its console log for Success', async (page) => {
      await open(page, { id: 'profile--success', backend: 'mokapi' });
      await openMokapiPanel(page);
      const request = await openRequest(page, 200);
      await request.getByText('Executed scripts').waitFor();
      await request.getByText(/profile\.js/).first().waitFor();
      const logs = await openDetails(request, 'Console logs');
      await logs.getByText(/profile mock: success/).waitFor();
    });

    await scenario('the panel shows status 500 and the validation error for Invalid', async (page) => {
      await open(page, { id: 'profile--invalid', backend: 'mokapi' });
      await openMokapiPanel(page);
      const request = await openRequest(page, 500);
      const errors = await openDetails(request, 'Response body / validation errors');
      await errors.getByText(/required properties are missing: email/).waitFor();
    });

    await scenario('on the Docs page, switching to Mokapi reloads both story iframes', async (page) => {
      const before = { success: await requestCount('success'), invalid: await requestCount('invalid') };
      await open(page, { id: 'profile--docs', docs: true });
      await showsText(profileInDocsStory(page, 'profile--success'), 'Jane Doe');
      await switchBackend(page, 'mokapi');
      await showsText(profileInDocsStory(page, 'profile--invalid'), 'HTTP 500');
      await showsText(profileInDocsStory(page, 'profile--success'), 'Jane Doe');
      await waitForRequestAfter('success', before.success);
      await waitForRequestAfter('invalid', before.invalid);
    });
  } finally {
    if (failureDirectory) console.error(`E2E failure artifacts kept in ${failureDirectory}`);
    if (browser) await browser.close();
    if (storybook) await storybook.stop();
    if (stopMokapi) await stopMokapi();
    await rm(directory, { recursive: true, force: true });
  }
});
