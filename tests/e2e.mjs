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

const VALIDATE_PATH = '/api/services/http/validate';
const TOGGLE_NAME = 'Validate with Mokapi';
const TOGGLE_TOOLTIPS = {
  on: 'Mokapi validation is on. Click to turn off.',
  off: 'Mokapi validation is off. Click to turn on.',
};

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

const mokapiConfig = (dashboardPort, filename) => `api:
  port: ${dashboardPort}
health:
  enabled: false
mcp:
  server:
    enabled: false
providers:
  file:
    filenames:
      - ${filename}
`;

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

// MOKAPI_BIN overrides the go-mokapi binary, e.g. for a local Mokapi build.
function mokapiBinary() {
  if (process.env.MOKAPI_BIN) return process.env.MOKAPI_BIN;
  const mokapiRequire = createRequire(require.resolve('go-mokapi/package.json'));
  return mokapiRequire(`@go-mokapi/${process.platform}-${process.arch}`);
}

// Starts Mokapi in directory and waits until isReady() passes, i.e. the contract is loaded.
async function startMokapi(directory, isReady) {
  // Mokapi rejects unknown MOKAPI_* environment variables, so MOKAPI_BIN must not reach it.
  const env = { ...process.env };
  delete env.MOKAPI_BIN;
  const child = spawn(mokapiBinary(), [], { cwd: directory, env, stdio: 'inherit' });
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
      await page.goto(`${url}/iframe.html?id=profile--valid&viewMode=story`);
      await page.getByTestId('profile').waitFor({ timeout: Math.max(1000, deadline - Date.now()) });
    } finally {
      await page.close();
    }
  } catch (error) {
    await fail('Storybook warm-up failed', error);
  }
  return { url, stop };
}

// Storybook's ToggleButton renders a button with role "switch" and aria-checked (what `pressed` maps to).
// Without a state it matches the switch in either state.
const toggleButton = (page, state) => page.getByRole('switch', {
  name: TOGGLE_NAME,
  ...(state && { checked: state === 'on' }),
});

async function switchValidation(page, state) {
  await toggleButton(page).click();
  // Storybook re-renders the story after the global changed.
  await toggleButton(page, state).waitFor();
}

// Opens a story or docs page like a Storybook user and optionally switches validation on.
async function openStory(page, storybookUrl, { id, docs = false, validation = false }) {
  await page.goto(`${storybookUrl}/?path=/${docs ? 'docs' : 'story'}/${id}`);
  // The toggle is shown in story view only.
  if (!docs) await toggleButton(page).waitFor();
  if (validation) {
    // A click while Storybook is still starting is lost: the preview's initial globals override it.
    await previewFrame(page).locator('#storybook-root > *').first().waitFor();
    // A switch in `completing` or `completed` re-renders at once and remounts too early (see src/remount.ts).
    await page.frame({ name: 'storybook-preview-iframe' })
      .waitForFunction(() => window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished');
    await switchValidation(page, 'on');
  }
}

const previewFrame = (page) => page.frameLocator('#storybook-preview-iframe');
const profileInPreview = (page) => previewFrame(page).getByTestId('profile');
const profileInDocsStory = (page) => previewFrame(page).frameLocator('#iframe--docs--valid').first().getByTestId('profile');

const showsText = (locator, text) => eventually(async () =>
  assert.equal(await locator.textContent({ timeout: 1000 }), text));

const mokapiTab = (page) => page.getByRole('tab', { name: /^Mokapi/ });
const openMokapiPanel = (page) => mokapiTab(page).click();

const entries = (page, status) =>
  page.locator(`[data-testid="mokapi-entry"]${status ? `[data-status="${status}"]` : ''}`);
const notice = (page, text) => page.getByRole('alert').filter({ hasText: text });

// The badge is part of the tab title; without invalid responses the title is just "Mokapi".
const badgeOf = async (page) => (await mokapiTab(page).textContent()).replace('Mokapi', '').trim();

// Records the requests the preview sends to Mokapi's validate endpoint.
function trackValidationRequests(page, dashboard) {
  const requests = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url() === `${dashboard}${VALIDATE_PATH}`) requests.push(request);
  });
  return requests;
}

// Validation runs after the response, so no request may show up shortly after the story rendered.
async function assertNothingSent(requests) {
  await setTimeout(1000);
  assert.equal(requests.length, 0);
}

test('Storybook user validates the MSW responses of a story against the OpenAPI contract', { timeout: 300000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mokapi-storybook-e2e-'));
  let failureDirectory;
  let stopMokapi;
  let browser;
  const storybooks = [];
  try {
    const [apiPort, dashboardPort, storybookPort, validatingStorybookPort] = await unusedPorts(4);
    const dashboard = `http://localhost:${dashboardPort}`;

    // Mokapi takes the HTTP port from the servers URL.
    const contract = JSON.parse(await readFile(join(fixtureDirectory, 'openapi.json'), 'utf8'));
    contract.servers = [{ url: `http://localhost:${apiPort}` }];
    await writeFile(join(directory, 'openapi.json'), JSON.stringify(contract));
    await writeFile(join(directory, 'mokapi.yaml'), mokapiConfig(dashboardPort, join(directory, 'openapi.json')));

    // Ready when the contract is loaded, which also fails early with a Mokapi without the endpoint.
    stopMokapi = await startMokapi(directory, async () => {
      const response = await fetch(`${dashboard}${VALIDATE_PATH}`, {
        method: 'POST',
        body: JSON.stringify({
          request: { method: 'GET', url: '/api/profile' },
          response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{"name":"a","email":"b"}' },
        }),
        signal: AbortSignal.timeout(1000),
      });
      assert.equal((await response.json()).valid, true);
    });

    browser = await chromium.launch();
    const startFixtureStorybook = async (port, env) => {
      const storybook = await startStorybook({ port, env: { MOKAPI_DASHBOARD: dashboard, ...env }, browser });
      storybooks.push(storybook);
      return storybook;
    };
    const storybook = await startFixtureStorybook(storybookPort, {});
    const validatingStorybook = await startFixtureStorybook(validatingStorybookPort, { MOKAPI_DEFAULT_VALIDATION: 'true' });

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
      const started = Date.now();
      const log = (line) => consoleLines.push(`+${Date.now() - started}ms ${line}`);
      page.on('console', (message) => log(`[${message.type()}] ${message.text()}`));
      page.on('pageerror', (error) => log(`[pageerror] ${error.message}`));
      page.on('framenavigated', (frame) => log(`[navigated] ${frame.name() || 'main'} ${frame.url()}`));
      page.on('request', (request) => {
        if (request.url() === `${dashboard}${VALIDATE_PATH}`) log(`[validate] ${request.postData()}`);
      });
      try {
        await run(page, context);
      } catch (error) {
        const panel = await entries(page).allTextContents().catch(() => []);
        panel.forEach((text) => log(`[panel entry] ${text}`));
        await keepFailureArtifacts(name, page, consoleLines);
        // CI keeps no files from the runner, so the log is the only trace there.
        console.error(`--- ${name}\n${consoleLines.join('\n')}`);
        throw error;
      } finally {
        await context.close();
      }
    });
    const open = (page, options) => openStory(page, storybook.url, options);

    await scenario('validation is off by default: the story renders and nothing is sent to Mokapi', async (page) => {
      const sent = trackValidationRequests(page, dashboard);
      await open(page, { id: 'profile--valid' });
      await showsText(profileInPreview(page), 'Jane Doe');
      await openMokapiPanel(page);
      await page.getByText(/Turn on validation/).waitFor();
      await assertNothingSent(sent);
    });

    await scenario('switching validation on validates the story without reloading the preview', async (page) => {
      await open(page, { id: 'profile--valid' });
      await showsText(profileInPreview(page), 'Jane Doe');
      const preview = page.frame({ name: 'storybook-preview-iframe' });
      await preview.evaluate(() => { window.__marker = 'same document'; });
      await openMokapiPanel(page);
      await toggleButton(page, 'off').hover();
      await page.getByRole('tooltip').getByText(TOGGLE_TOOLTIPS.off).waitFor();
      await switchValidation(page, 'on');
      // The tooltip closes on press while the pointer stays on the button; leave it so hover() enters again.
      await page.mouse.move(0, 0);
      await toggleButton(page, 'on').hover();
      await page.getByRole('tooltip').getByText(TOGGLE_TOOLTIPS.on).waitFor();
      // One plain switch, no dropdown: a leftover globalTypes toolbar would be a button with a popup.
      assert.equal(await toggleButton(page).getAttribute('aria-haspopup'), null);
      assert.equal(await page.getByRole('button', { name: TOGGLE_NAME }).count(), 0);
      await entries(page, 'valid').waitFor();
      assert.equal(await preview.evaluate(() => window.__marker), 'same document');
    });

    await scenario('defaultValidation true starts with validation on', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'profile--valid' });
      await toggleButton(page, 'on').waitFor();
      await openMokapiPanel(page);
      await entries(page, 'valid').waitFor();
    });

    await scenario('a valid response is listed as valid and does not show a badge', async (page) => {
      await open(page, { id: 'profile--valid', validation: true });
      await openMokapiPanel(page);
      const valid = entries(page, 'valid');
      await valid.waitFor();
      assert.match(await valid.textContent(), /GET \/api\/profile/);
      assert.match(await valid.textContent(), /200/);
      assert.equal(await entries(page).count(), 1);
      assert.equal(await badgeOf(page), '');
      // The component gets the MSW response unchanged.
      await showsText(profileInPreview(page), 'Jane Doe');
    });

    await scenario('an invalid response shows location and message of the contract violation and a badge', async (page) => {
      await open(page, { id: 'profile--invalid', validation: true });
      await openMokapiPanel(page);
      const invalid = entries(page, 'invalid');
      await invalid.waitFor();
      assert.match(await invalid.textContent(), /response\.body/);
      assert.match(await invalid.textContent(), /required properties are missing: email/);
      await eventually(async () => assert.equal(await badgeOf(page), '1'));
      await showsText(profileInPreview(page), 'Jane Doe');
    });

    await scenario('a request that matches no operation is not in contract and does not count in the badge', async (page) => {
      await open(page, { id: 'profile--not-in-contract', validation: true });
      await openMokapiPanel(page);
      const notInContract = entries(page, 'not-in-contract');
      await notInContract.waitFor();
      assert.match(await notInContract.textContent(), /no operation found for GET \/api\/settings/);
      assert.equal(await badgeOf(page), '');
    });

    await scenario('handlers with path patterns are validated against the contract path', async (page) => {
      await open(page, { id: 'profile--path-pattern', validation: true });
      await openMokapiPanel(page);
      const valid = entries(page, 'valid');
      await valid.waitFor();
      assert.match(await valid.textContent(), /GET \/api\/users\/42/);
    });

    await scenario('the request body of a POST is validated', async (page) => {
      await open(page, { id: 'profile--post-invalid-body', validation: true });
      await openMokapiPanel(page);
      const invalid = entries(page, 'invalid');
      await invalid.waitFor();
      assert.match(await invalid.textContent(), /POST \/api\/profile/);
      assert.match(await invalid.textContent(), /request\.body/);
      assert.match(await invalid.textContent(), /required properties are missing: name/);

      await open(page, { id: 'profile--post-valid', validation: true });
      await entries(page, 'valid').waitFor();
    });

    await scenario('switching validation on while the story is still rendering validates once without reloading the preview', async (page) => {
      await open(page, { id: 'profile--slow-after-each' });
      await previewFrame(page).locator('#storybook-root > *').first().waitFor();
      const preview = page.frame({ name: 'storybook-preview-iframe' });
      await preview.evaluate(() => { window.__marker = 'same document'; });
      // The render is held in afterEach for seconds, so the switch arrives while it is pending.
      await switchValidation(page, 'on');
      await openMokapiPanel(page);
      await entries(page, 'valid').first().waitFor();
      await setTimeout(1500);
      assert.equal(await entries(page).count(), 1);
      assert.equal(await preview.evaluate(() => window.__marker), 'same document');
    });

    await scenario('a story with disable true sends nothing', async (page) => {
      const sent = trackValidationRequests(page, dashboard);
      await open(page, { id: 'profile--disabled', validation: true });
      await showsText(profileInPreview(page), 'Jane Doe');
      await openMokapiPanel(page);
      await assertNothingSent(sent);
      assert.equal(await entries(page).count(), 0);
    });

    await scenario('passthrough responses are not validated', async (page) => {
      const sent = trackValidationRequests(page, dashboard);
      await open(page, { id: 'profile--passthrough', validation: true });
      await eventually(async () => assert.notEqual(await profileInPreview(page).textContent({ timeout: 1000 }), 'Loading...'));
      await openMokapiPanel(page);
      await assertNothingSent(sent);
      assert.equal(await entries(page).count(), 0);
    });

    await scenario('switching the story and re-rendering it clear the list', async (page) => {
      await open(page, { id: 'profile--valid', validation: true });
      await openMokapiPanel(page);
      await entries(page, 'valid').waitFor();

      // Switching validation off and on renders the story again: one entry, not two.
      await switchValidation(page, 'off');
      await switchValidation(page, 'on');
      await entries(page, 'valid').waitFor();
      assert.equal(await entries(page).count(), 1);

      await page.locator('[id="profile--invalid"]').click();
      await entries(page, 'invalid').waitFor();
      assert.equal(await entries(page, 'valid').count(), 0);
    });

    await scenario('an unknown API shows a configuration notice with Mokapi\'s message and no badge', async (page) => {
      await open(page, { id: 'profile--unknown-api', validation: true });
      await openMokapiPanel(page);
      await notice(page, /api 'Unknown API' not found/).waitFor();
      assert.equal(await entries(page).count(), 0);
      assert.equal(await badgeOf(page), '');
    });

    await scenario('a story without context.msw renders and the panel names the missing worker', async (page) => {
      await open(page, { id: 'profile--without-worker', validation: true });
      await showsText(profileInPreview(page), 'Jane Doe');
      await openMokapiPanel(page);
      await notice(page, /MSW worker not found: `context\.msw` is missing/).waitFor();
      assert.equal(await entries(page).count(), 0);
    });

    await scenario('a Mokapi that is not reachable shows a notice with the URL and no badge', async (page, context) => {
      await context.route(`${dashboard}/**`, (route) => route.abort('connectionrefused'));
      await open(page, { id: 'profile--valid', validation: true });
      await showsText(profileInPreview(page), 'Jane Doe');
      await openMokapiPanel(page);
      await notice(page, new RegExp(`not reachable.*${dashboard}`)).waitFor();
      const unreachable = entries(page, 'unreachable');
      await unreachable.waitFor();
      assert.match(await unreachable.textContent(), /Mokapi not reachable/);
      assert.match(await unreachable.textContent(), /GET \/api\/profile/);
      assert.match(await unreachable.textContent(), new RegExp(`${dashboard}.*dashboardUrl`));
      assert.equal(await badgeOf(page), '');
    });

    await scenario('on a Docs page with inline false every story validates in its own iframe', async (page) => {
      const sent = trackValidationRequests(page, dashboard);
      await openStory(page, validatingStorybook.url, { id: 'docs--docs', docs: true });
      await showsText(profileInDocsStory(page), 'Jane Doe');
      await eventually(async () => assert.ok(sent.length > 0, 'validation request from the story iframe'));
      assert.equal(await toggleButton(page).count(), 0);
    });
  } finally {
    if (failureDirectory) console.error(`E2E failure artifacts kept in ${failureDirectory}`);
    if (browser) await browser.close();
    await Promise.all(storybooks.map((storybook) => storybook.stop()));
    if (stopMokapi) await stopMokapi();
    await rm(directory, { recursive: true, force: true });
  }
});
