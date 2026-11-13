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
const TEST_MODE_TEXTS = {
  error: 'Test mode: error. Contract errors make this story fail.',
  todo: 'Test mode: todo. Contract errors are reported as warnings, the story stays green.',
  off: 'Test mode: off. Contract errors are shown here only.',
};
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

// Switches and waits for both renders that follow: Storybook's re-render and the addon's remount.
// Expects a finished story, because it counts the `storyFinished` events that follow the switch.
async function switchValidationAndWait(page, state) {
  const preview = page.frame({ name: 'storybook-preview-iframe' });
  const finished = await preview.evaluate(() => {
    if (window.__finishedRenders === undefined) {
      window.__finishedRenders = 0;
      window.__STORYBOOK_ADDONS_CHANNEL__.on('storyFinished', () => { window.__finishedRenders += 1; });
    }
    return window.__finishedRenders;
  });
  await switchValidation(page, state);
  await preview.waitForFunction((count) => window.__finishedRenders >= count, finished + 2);
}

// Opens a story or docs page like a Storybook user and optionally switches validation on.
async function openStory(page, storybookUrl, { id, docs = false, validation = false }) {
  await page.goto(`${storybookUrl}/?path=/${docs ? 'docs' : 'story'}/${id}`);
  // The toggle is shown in story view only.
  if (!docs) await toggleButton(page).waitFor();
  if (validation) {
    // A click while Storybook is still starting is lost: the preview's initial globals override it.
    await previewFrame(page).locator('#storybook-root > *').first().waitFor();
    await page.frame({ name: 'storybook-preview-iframe' })
      .waitForFunction(() => window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished');
    await switchValidationAndWait(page, 'on');
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

// Records the `storyFinished` payloads of every frame from its creation on: the channel is created
// while the preview boots, so the recorder hooks the global slot Storybook assigns it to. It runs in
// every document (also the iframe's initial about:blank), so readers must tolerate a missing array.
const recordFinishedStories = (context) => context.addInitScript(() => {
  window.__storyFinished = [];
  let channel;
  Object.defineProperty(window, '__STORYBOOK_ADDONS_CHANNEL__', {
    configurable: true,
    get: () => channel,
    set(next) {
      if (next && next !== channel) next.on('storyFinished', (event) => window.__storyFinished.push(event));
      channel = next;
    },
  });
});

// The last `storyFinished` of the story: after a remount that is the render that counts.
async function finishedStory(page) {
  const preview = page.frame({ name: 'storybook-preview-iframe' });
  await preview.waitForFunction(() => window.__storyFinished?.length > 0, null, { timeout: 20000 });
  return (await preview.evaluate(() => window.__storyFinished)).at(-1);
}

const mokapiReports = (finished) => finished.reporters.filter(({ type }) => type === 'mokapi');

// Storybook's error display of the preview: a contract error must not show it.
const errorDisplay = (frame) => frame.locator('body.sb-show-errordisplay');

// A failing story finishes with status error through its failed Mokapi report alone: no error display.
// Needs the Mokapi panel to be open, because the message is checked in its headline.
async function assertStoryFails(page, message) {
  await eventually(async () => {
    const finished = await finishedStory(page);
    assert.equal(finished.status, 'error');
    assert.deepEqual(mokapiReports(finished).map(({ status }) => status), ['failed']);
  });
  assert.equal(await errorDisplay(previewFrame(page)).count(), 0);
  await eventually(async () => assert.match(await reportHeadline(page).textContent({ timeout: 1000 }), message));
  assert.equal(await reportBadge(page).textContent(), 'FAIL');
}

async function assertStoryStaysGreen(page) {
  const finished = await finishedStory(page);
  assert.equal(finished.status, 'success');
  assert.equal(await errorDisplay(previewFrame(page)).count(), 0);
  return finished;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const operationLink = (page, status) => entries(page, status).getByTestId('mokapi-operation');
// The panel's own badge is read by test id, so that `PASS` and `FAIL` don't clash with the number in the tab badge.
const reportBadge = (page) => page.getByTestId('mokapi-report-badge');
const reportHeadline = (page) => page.getByTestId('mokapi-report-headline');
const reportCounts = (page) => page.getByTestId('mokapi-report-counts');
// Only test mode off shows the text in the toolbar, the other modes show it as the tooltip of the badge.
const testModeOffText = (page) => page.getByTestId('mokapi-test-mode');
const rerunButton = (page) => page.getByTestId('mokapi-rerun');
const entryDetails = (entry) => entry.getByTestId('mokapi-details');
const toggleDetails = (entry) => entryDetails(entry).locator('summary').click();
const EMPTY_LIST_TEXT = 'No responses validated since this story was mounted.';

async function assertBadgeTooltip(page, text) {
  await reportBadge(page).hover();
  await page.getByText(text).waitFor();
  await page.mouse.move(0, 0);
}

// The preview's render is over when its phase is `finished`: the state Rerun is enabled in.
const waitForFinishedRender = (page) => page.frame({ name: 'storybook-preview-iframe' })
  .waitForFunction(() => window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished');

// The Mokapi status in the sidebar row of a story: Storybook's status icon button, e.g. "Test status: Error".
const sidebarRow = (page, id) => page.locator(`[data-item-id="${id}"]`);
const sidebarStatusButton = (page, id) => sidebarRow(page, id).getByTestId('tree-status-button');
const assertSidebarStatus = (page, id, label) => eventually(async () =>
  assert.equal(await sidebarStatusButton(page, id).getAttribute('aria-label', { timeout: 1000 }), `Test status: ${label}`));
const assertNoSidebarStatus = (page, id) => eventually(async () =>
  assert.equal(await sidebarStatusButton(page, id).count(), 0));
const clearAllStatusesButton = (page) => page.getByRole('button', { name: 'Clear all statuses' });
const dashboardOperationUrl = (dashboard, path) => `${dashboard}/dashboard/http/services/${path}`;

// Runs the fixture's stories with @storybook/addon-vitest (Vitest browser mode, Vitest's default testTimeout)
// and returns Vitest's JSON result of the stories whose export names are given.
async function runStoriesWithVitest(env, outputFile, storyNames) {
  const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const pattern = storyNames.map((name) => name.replace(/(?<=.)([A-Z])/g, ' $1')).join('|');
  const child = spawn(process.execPath, [
    cli, 'run', 'TestMode.stories', '--reporter=json', `--outputFile=${outputFile}`, '--testNamePattern', pattern,
  ], { cwd: fixtureDirectory, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; });
  // A failing story makes Vitest exit with 1, so the exit code says nothing: the JSON file does.
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  let result;
  try {
    result = JSON.parse(await readFile(outputFile, 'utf8'));
  } catch (error) {
    throw new Error(`Vitest wrote no result\n${output.slice(-4000)}`, { cause: error });
  }
  const stories = result.testResults.flatMap(({ assertionResults }) => assertionResults);
  const summary = stories.map(({ title, status, failureMessages }) =>
    `${title}: ${status}${failureMessages.length ? ` (${failureMessages[0].split('\n')[0]})` : ''}`).join('\n');
  return (name) => {
    const story = stories.find(({ title }) => title.replace(/\s/g, '') === name);
    assert.ok(story, `Vitest did not run ${name}\nResults:\n${summary}\n${output.slice(-4000)}`);
    return { ...story, expect: (status) => assert.equal(story.status, status,
      `${name} should be ${status} under Vitest\nResults:\n${summary}\n${output.slice(-4000)}`) };
  };
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
    const [apiPort, dashboardPort, storybookPort, validatingStorybookPort, failingStorybookPort] = await unusedPorts(5);
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
    const failingStorybook = await startFixtureStorybook(failingStorybookPort, {
      MOKAPI_DEFAULT_VALIDATION: 'true',
      MOKAPI_DEFAULT_TEST: 'error',
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
      await recordFinishedStories(context);
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

    await scenario('switching validation on while the story finishes its render validates once without reloading the preview', async (page) => {
      await open(page, { id: 'profile--animated' });
      const preview = page.frame({ name: 'storybook-preview-iframe' });
      await preview.evaluate(() => { window.__marker = 'same document'; });
      // Local channel listeners run synchronously in emission order. Storybook emits `globalsUpdated`
      // right before it calls `rerender()`, so the entry after 'globalsUpdated' is the re-render's first phase.
      await preview.waitForFunction(() => window.__STORYBOOK_PREVIEW__?.currentRender);
      await preview.evaluate(() => {
        // Starts with the current phase, because the render may already be in `completing`.
        window.__events = [window.__STORYBOOK_PREVIEW__.currentRender.phase];
        const channel = window.__STORYBOOK_ADDONS_CHANNEL__;
        channel.on('storyRenderPhaseChanged', ({ newPhase }) => window.__events.push(newPhase));
        channel.on('globalsUpdated', () => window.__events.push('globalsUpdated'));
      });
      // The animation keeps the render in `completing`: not pending, so Storybook re-renders at once.
      await preview.waitForFunction(() => window.__events.at(-1) === 'completing');
      // Storybook emits its own `globalsUpdated` while the story starts, so look only after this point.
      const beforeSwitch = await preview.evaluate(() => window.__events.length);
      // The old render times out in `completing` 5 s after it started. Switch late enough that the re-render
      // finishes clearly after it, but before the old render leaves `completing`.
      await setTimeout(1500);
      await switchValidation(page, 'on');
      // The remount is the second `loading` after the switch (the first is the re-render).
      await preview.waitForFunction((from) => {
        const rest = window.__events.slice(from);
        return rest.indexOf('loading', rest.indexOf('loading') + 1) > 0;
      }, beforeSwitch);
      await openMokapiPanel(page);
      await entries(page, 'valid').first().waitFor();
      await setTimeout(1500);
      assert.equal(await entries(page).count(), 1);
      assert.equal(await preview.evaluate(() => window.__marker), 'same document');
      // Without this check the switch may land in `afterEach` or `finished` and exercise another path.
      const events = await preview.evaluate(() => window.__events);
      const switched = events.indexOf('globalsUpdated', beforeSwitch);
      assert.deepEqual(events.slice(switched - 1, switched + 2), ['completing', 'globalsUpdated', 'loading'],
        `the switch must land in the running render's 'completing' phase and start the re-render at once, got: ${events.join(', ')}`);
      // A remount before the re-render has finished cancels it: the re-render then reports `aborted`
      // and still emits its `finished`, so only the missing `aborted` shows that the remount waited.
      const afterSwitch = events.slice(switched);
      const remount = afterSwitch.indexOf('loading', afterSwitch.indexOf('loading') + 1);
      assert.ok(!afterSwitch.slice(0, remount).includes('aborted'),
        `the remount must not cancel the re-render, got: ${events.join(', ')}`);
    });

    await scenario('a story with disable true sends nothing', async (page) => {
      const sent = trackValidationRequests(page, dashboard);
      await open(page, { id: 'profile--disabled', validation: true });
      await showsText(profileInPreview(page), 'Jane Doe');
      await openMokapiPanel(page);
      await assertNothingSent(sent);
      assert.equal(await entries(page).count(), 0);
      await page.getByText(EMPTY_LIST_TEXT).waitFor();
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
      await switchValidationAndWait(page, 'off');
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

    // Opens the story in the Storybook that has validation on from the start and waits for the panel.
    const openValidated = async (page, id, storybookUnderTest = validatingStorybook) => {
      await openStory(page, storybookUnderTest.url, { id });
      await openMokapiPanel(page);
    };

    await scenario('a valid and an invalid response link to the matched operation in the dashboard', async (page) => {
      await openValidated(page, 'profile--valid');
      const link = operationLink(page, 'valid');
      await link.waitFor();
      assert.equal(await link.textContent(), 'GET /api/profile');
      assert.equal(await link.getAttribute('title'), 'GET /api/profile');
      assert.equal(await link.getAttribute('href'), dashboardOperationUrl(dashboard, 'Profile%20API/api/profile/get'));
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await link.getAttribute('rel'), 'noreferrer');

      await openValidated(page, 'profile--invalid');
      assert.equal(await operationLink(page, 'invalid').textContent(), 'GET /api/profile');
      assert.equal(await operationLink(page, 'invalid').getAttribute('title'), 'GET /api/profile');
      assert.equal(
        await operationLink(page, 'invalid').getAttribute('href'),
        dashboardOperationUrl(dashboard, 'Profile%20API/api/profile/get'),
      );
    });

    await scenario('the operation link shows the request, titles the path template and encodes its braces', async (page) => {
      await openValidated(page, 'profile--path-pattern');
      const link = operationLink(page, 'valid');
      await link.waitFor();
      assert.equal(await link.textContent(), 'GET /api/users/42');
      assert.equal(await link.getAttribute('title'), 'GET /api/users/{id}');
      assert.equal(await link.getAttribute('href'), dashboardOperationUrl(dashboard, 'Profile%20API/api/users/%7Bid%7D/get'));
    });

    await scenario('an entry that is not in the contract or not reachable has no operation link', async (page, context) => {
      await openValidated(page, 'profile--not-in-contract');
      await entries(page, 'not-in-contract').waitFor();
      assert.equal(await page.getByTestId('mokapi-operation').count(), 0);

      await context.route(`${dashboard}/**`, (route) => route.abort('connectionrefused'));
      await openValidated(page, 'profile--valid');
      await entries(page, 'unreachable').waitFor();
      assert.equal(await page.getByTestId('mokapi-operation').count(), 0);
    });

    for (const [id, mode] of [['profile--error-invalid', 'error'], ['profile--todo-invalid', 'todo']]) {
      await scenario(`the badge tooltip shows the test mode ${mode} of the story`, async (page) => {
        await openValidated(page, id);
        await reportBadge(page).waitFor();
        await assertBadgeTooltip(page, TEST_MODE_TEXTS[mode]);
        assert.equal(await testModeOffText(page).count(), 0);
      });
    }

    await scenario('test mode off shows no badge, the counts and the test mode text in the toolbar', async (page) => {
      await openValidated(page, 'profile--off-invalid');
      await showsText(testModeOffText(page), TEST_MODE_TEXTS.off);
      await entries(page, 'invalid').waitFor();
      await showsText(reportCounts(page), '1 response validated, 1 invalid');
      assert.equal(await reportBadge(page).count(), 0);
      assert.equal(await reportHeadline(page).count(), 0);
    });

    await scenario('an invalid test parameter shows the default test mode and a configuration notice', async (page) => {
      await openValidated(page, 'profile--invalid-test-parameter');
      await reportBadge(page).waitFor();
      await assertBadgeTooltip(page, TEST_MODE_TEXTS.todo);
      await notice(page, "Mokapi: parameters.mokapi.test must be 'error', 'todo' or 'off'.").waitFor();
      await assertStoryStaysGreen(page);
    });

    await scenario('a disabled story shows the toolbar without badge and test mode text', async (page) => {
      await openValidated(page, 'profile--error-disabled');
      await assertStoryStaysGreen(page);
      assert.equal(await testModeOffText(page).count(), 0);
      assert.equal(await reportBadge(page).count(), 0);
    });

    await scenario('with validation off the panel shows only the toggle hint, without toolbar and Rerun', async (page) => {
      await openValidated(page, 'profile--error-invalid', storybook);
      await page.getByText(/Turn on validation/).waitFor();
      assert.equal(await testModeOffText(page).count(), 0);
      assert.equal(await reportBadge(page).count(), 0);
      assert.equal(await reportCounts(page).count(), 0);
      assert.equal(await rerunButton(page).count(), 0);
    });

    await scenario('the toolbar counts the validated responses in one line and names only the kinds that occur', async (page) => {
      await openValidated(page, 'profile--error-mixed');
      await showsText(reportCounts(page), '2 responses validated, 1 valid, 1 invalid');

      await openValidated(page, 'profile--error-invalid');
      await showsText(reportCounts(page), '1 response validated, 1 invalid');
    });

    await scenario('the badge shows the report of the test mode, with the headline for warnings and failures only', async (page) => {
      await openValidated(page, 'profile--error-invalid');
      await showsText(reportBadge(page), 'FAIL');
      await showsText(reportHeadline(page), 'Mokapi: 1 response does not match the contract.');

      await openValidated(page, 'profile--todo-invalid');
      await showsText(reportBadge(page), 'WARN');
      await showsText(reportHeadline(page), 'Mokapi: 1 response does not match the contract.');

      await openValidated(page, 'profile--error-valid');
      await showsText(reportBadge(page), 'PASS');
      assert.equal(await reportHeadline(page).count(), 0);
    });

    await scenario('the badge shows WAIT while the story still validates', async (page) => {
      await openValidated(page, 'profile--error-delayed');
      await showsText(reportBadge(page), 'WAIT');
      assert.equal(await reportHeadline(page).count(), 0);
      await showsText(reportBadge(page), 'FAIL');
    });

    await scenario('Rerun validates the story again without reloading the preview and replaces the report', async (page, context) => {
      const sent = trackValidationRequests(page, dashboard);
      await openValidated(page, 'profile--error-invalid');
      await showsText(reportBadge(page), 'FAIL');
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');
      await eventually(async () => assert.equal(sent.length, 1));
      const preview = page.frame({ name: 'storybook-preview-iframe' });
      await preview.evaluate(() => { window.__marker = 'same document'; });

      // From now on Mokapi accepts the response, so the new report differs from the first one.
      await context.route(`${dashboard}${VALIDATE_PATH}`, (route) => route.fulfill({
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ valid: true, errors: [] }),
      }));
      // Playwright waits until the button is enabled, i.e. until the render has finished.
      await rerunButton(page).click();

      await showsText(reportBadge(page), 'PASS');
      await eventually(async () => assert.equal(sent.length, 2));
      assert.equal(await entries(page).count(), 1);
      assert.equal(await entries(page, 'invalid').count(), 0);
      await assertNoSidebarStatus(page, 'profile--error-invalid');
      assert.equal(await preview.evaluate(() => window.__marker), 'same document');
    });

    await scenario('Rerun is disabled while the story renders and enabled after the render has finished', async (page) => {
      // afterEach holds the render for seconds.
      await openStory(page, validatingStorybook.url, { id: 'profile--slow-after-each' });
      await openMokapiPanel(page);
      await eventually(async () => assert.equal(await rerunButton(page).isDisabled({ timeout: 1000 }), true));
      await waitForFinishedRender(page);
      await eventually(async () => assert.equal(await rerunButton(page).isDisabled({ timeout: 1000 }), false));
    });

    await scenario('an entry row shows kind, method and URL, status code and time, and the errors without expanding', async (page) => {
      await openValidated(page, 'profile--invalid');
      const invalid = entries(page, 'invalid');
      await invalid.waitFor();
      const text = await invalid.textContent();
      assert.match(text, /invalid/);
      assert.match(text, /GET \/api\/profile/);
      assert.match(text, /200/);
      assert.match(text, /\d+:\d{2}/);
      assert.ok(await invalid.getByText(/required properties are missing: email/).isVisible());
      assert.equal(await invalid.getByText('(empty)').isVisible(), false);
    });

    await scenario('Request and Response are collapsed and show headers and pretty-printed bodies when expanded', async (page) => {
      await openValidated(page, 'profile--valid');
      const valid = entries(page, 'valid');
      await valid.waitFor();
      assert.equal(await entryDetails(valid).getAttribute('open'), null);
      await toggleDetails(valid);
      const get = await entryDetails(valid).textContent();
      assert.match(get, /GET \/api\/profile/);
      assert.match(get, /\(empty\)/);
      assert.match(get, /content-type: application\/json/);
      assert.match(get, /\{\s*\n\s+"name": "Jane Doe"/);
      assert.match(get, /200/);

      await openValidated(page, 'profile--post-valid');
      const post = entries(page, 'valid');
      await post.waitFor();
      await toggleDetails(post);
      const posted = await entryDetails(post).textContent();
      assert.match(posted, /POST \/api\/profile/);
      assert.match(posted, /content-type: application\/json/);
      assert.match(posted, /\{\s*\n\s+"name": "Jane Doe",\s*\n\s+"email": "jane@example.com"/);
      assert.doesNotMatch(posted, /\(empty\)/);
    });

    await scenario('a body over 10,000 characters is cut in the panel while Mokapi validates the full body', async (page) => {
      const sent = trackValidationRequests(page, dashboard);
      await openValidated(page, 'profile--large-body');
      const entry = entries(page).first();
      await entry.waitFor();
      await toggleDetails(entry);
      await entryDetails(entry).getByText(/truncated/).waitFor();
      assert.ok((await entryDetails(entry).textContent()).length < 12000);
      assert.equal(JSON.parse(JSON.parse(sent[0].postData()).response.body).name.length, 12000);
      assert.equal(await entries(page, 'valid').count(), 1);
    });

    // The dev server holds Storybook's status store, so statuses of earlier scenarios are still there.
    // Opens a story that passes (it sets no status), clears all statuses and then selects the story in
    // the sidebar without a reload: whatever status the story has afterwards was set by this run.
    const openWithClearedStatuses = async (page, id) => {
      await openValidated(page, 'profile--error-valid');
      await showsText(reportBadge(page), 'PASS');
      // The button exists only while the store holds statuses, which reach the manager asynchronously.
      await clearAllStatusesButton(page).click({ timeout: 2000 }).catch(() => {});
      await assertNoSidebarStatus(page, 'profile--error-invalid');
      await page.locator(`[id="${id}"]`).click();
    };

    await scenario('a story with an error or a warning gets a Mokapi status in the sidebar, a passed one none', async (page) => {
      await openWithClearedStatuses(page, 'profile--error-invalid');
      await showsText(reportHeadline(page), 'Mokapi: 1 response does not match the contract.');
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');

      await openValidated(page, 'profile--todo-invalid');
      await showsText(reportBadge(page), 'WARN');
      await assertSidebarStatus(page, 'profile--todo-invalid', 'Warning');

      // A passed story has no status. That a passed check removes the status of an earlier failing run
      // of the same story is not covered here: no fixture story changes its verdict between runs.
      await page.locator('[id="profile--error-valid"]').click();
      await showsText(reportBadge(page), 'PASS');
      await assertNoSidebarStatus(page, 'profile--error-valid');

      for (const id of ['profile--off-invalid', 'profile--error-disabled']) {
        await page.locator(`[id="${id}"]`).click();
        await assertStoryStaysGreen(page);
        await assertNoSidebarStatus(page, id);
      }
    });

    await scenario('the Mokapi status stays when the story is switched and a story without validation gets none', async (page) => {
      await openWithClearedStatuses(page, 'profile--error-invalid');
      await showsText(reportHeadline(page), 'Mokapi: 1 response does not match the contract.');
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');
      await page.locator('[id="profile--error-valid"]').click();
      await showsText(reportBadge(page), 'PASS');
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');

      await openStory(page, storybook.url, { id: 'profile--off-invalid' });
      await assertNoSidebarStatus(page, 'profile--off-invalid');
    });

    await scenario('selecting the Mokapi status in the sidebar opens the Mokapi panel', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'profile--error-invalid' });
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');
      assert.equal(await page.getByRole('tab', { name: /^Mokapi/, selected: true }).count(), 0);

      // The context menu of a sidebar row lists its statuses; it exists in Storybook's dev server only.
      await sidebarRow(page, 'profile--error-invalid').hover();
      await sidebarRow(page, 'profile--error-invalid').getByRole('button', { name: 'Open context menu' }).click();
      await page.getByLabel('Test status for Mokapi: status-value:error').first().click();
      await page.getByRole('tab', { name: /^Mokapi/, selected: true }).waitFor();
      await showsText(reportHeadline(page), 'Mokapi: 1 response does not match the contract.');
    });

    await scenario('Clear all statuses removes the Mokapi statuses and the Run tests widget names Mokapi in one line', async (page) => {
      await openWithClearedStatuses(page, 'profile--error-invalid');
      // The headline is this render's report: the status is set after it, so Clear can't be overtaken.
      await showsText(reportHeadline(page), 'Mokapi: 1 response does not match the contract.');
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');

      await page.getByRole('button', { name: 'Expand testing module' }).click();
      await showsText(page.locator('[data-module-id="mokapi/test-provider"]'), 'Mokapi contract validation');

      await clearAllStatusesButton(page).click();
      await assertNoSidebarStatus(page, 'profile--error-invalid');
    });

    await scenario('with test error a response that does not match the contract fails the story', async (page) => {
      await openValidated(page, 'profile--error-invalid');
      await assertStoryFails(page, /^Mokapi: 1 response does not match the contract\.$/);
      // The details are in the entry.
      const url = escapeRegExp(dashboardOperationUrl(dashboard, 'Profile%20API/api/profile/get'));
      await entries(page, 'invalid').waitFor();
      assert.match(await entries(page, 'invalid').textContent(), /response\.body.*required properties are missing: email/);
      assert.match(await operationLink(page, 'invalid').getAttribute('href'), new RegExp(`^${url}$`));
    });

    await scenario('with test error a Mokapi that is not reachable fails the story', async (page, context) => {
      await context.route(`${dashboard}/**`, (route) => route.abort('connectionrefused'));
      await openValidated(page, 'profile--error-valid');
      await assertStoryFails(page, new RegExp(`Mokapi is not reachable at ${dashboard}`));
    });

    await scenario('with test error a Mokapi without the validate endpoint fails the story', async (page, context) => {
      await context.route(`${dashboard}${VALIDATE_PATH}`, (route) =>
        route.fulfill({ status: 405, headers: { 'Access-Control-Allow-Origin': '*' } }));
      await openValidated(page, 'profile--error-valid');
      await assertStoryFails(page, /does not support \/api\/services\/http\/validate/);
    });

    await scenario('with test error an unknown API fails the story', async (page) => {
      await openValidated(page, 'profile--error-unknown-api');
      await assertStoryFails(page, /api 'Unknown API' not found/);
    });

    await scenario('with test error a story that waits for its response and its validation still fails', async (page) => {
      await openValidated(page, 'profile--error-delayed');
      await assertStoryFails(page, /Mokapi: 1 response does not match the contract\./);
    });

    await scenario('with test error a response that never comes fails the story after 4 s with a timeout notice', async (page) => {
      await openValidated(page, 'profile--error-never-answers');
      await showsText(reportBadge(page), 'WAIT');
      await assertStoryFails(page, /Mokapi validation did not finish within 4 s \(GET \/api\/profile\)\./);
      await notice(page, /Mokapi validation did not finish within 4 s \(GET \/api\/profile\)\./).waitFor();
    });

    for (const id of ['profile--error-valid', 'profile--error-no-worker', 'profile--error-no-request', 'profile--error-bypass', 'profile--error-handler-throws']) {
      await scenario(`with test error the story ${id} does not fail`, async (page) => {
        await openValidated(page, id);
        await assertStoryStaysGreen(page);
      });
    }

    await scenario('with test error a disabled story and validation off never fail', async (page) => {
      await openValidated(page, 'profile--error-disabled');
      const disabled = await assertStoryStaysGreen(page);
      assert.deepEqual(mokapiReports(disabled), []);

      await openStory(page, storybook.url, { id: 'profile--error-invalid' });
      assert.deepEqual(mokapiReports(await assertStoryStaysGreen(page)), []);
    });

    await scenario('with test todo the contract error stays green and is reported as a warning', async (page) => {
      await openValidated(page, 'profile--todo-invalid');
      const [report, ...others] = mokapiReports(await assertStoryStaysGreen(page));
      assert.equal(others.length, 0);
      assert.equal(report.status, 'warning');
      assert.equal(report.version, 1);
      assert.equal(report.result.entries[0].status, 'invalid');
      assert.equal(
        report.result.entries[0].operationUrl,
        dashboardOperationUrl(dashboard, 'Profile%20API/api/profile/get'),
      );
    });

    await scenario('with test off the contract error stays green and no report is added', async (page) => {
      await openValidated(page, 'profile--off-invalid');
      await entries(page, 'invalid').waitFor();
      assert.deepEqual(mokapiReports(await assertStoryStaysGreen(page)), []);
    });

    await scenario('switching validation on counts only the render after the remount', async (page) => {
      await openStory(page, storybook.url, { id: 'profile--error-invalid', validation: true });
      await openMokapiPanel(page);
      await assertStoryFails(page, /Mokapi: 1 response does not match the contract\./);
      assert.equal(await entries(page, 'invalid').count(), 1);
    });

    await scenario('a re-render after another global changed keeps the invalid result and the failing story', async (page) => {
      // `theme` is a second global of the fixture that no story uses. Changing it re-renders the story without remounting it.
      await page.goto(`${storybook.url}/?path=/story/profile--error-invalid&globals=mokapiValidation:on;theme:light`);
      await toggleButton(page, 'on').waitFor();
      await openMokapiPanel(page);
      await assertStoryFails(page, /Mokapi: 1 response does not match the contract\./);
      await entries(page, 'invalid').waitFor();

      const preview = page.frame({ name: 'storybook-preview-iframe' });
      const finished = await preview.evaluate(() => window.__storyFinished.length);
      await page.evaluate(() => window.__STORYBOOK_ADDONS_CHANNEL__.emit('updateGlobals', { globals: { theme: 'dark' } }));
      await preview.waitForFunction((count) => window.__storyFinished.length > count, finished);

      await assertStoryFails(page, /Mokapi: 1 response does not match the contract\./);
      assert.equal(await entries(page, 'invalid').count(), 1);
      assert.equal(await page.getByText(/No responses validated/).count(), 0);
    });

    await scenario('on a Docs page a story with test error shows no error in its frame', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'docs-test-mode--docs', docs: true });
      const frame = await previewFrame(page).locator('#iframe--docs-test-mode--error-invalid').first().elementHandle();
      const story = await frame.contentFrame();
      // The story finished with status error because of its failed report, and the frame still shows the story.
      await story.waitForFunction(() => window.__storyFinished?.at(-1)?.status === 'error', null, { timeout: 20000 });
      await story.getByTestId('profile').waitFor();
      assert.equal(await errorDisplay(story).count(), 0);
    });

    await t.test('Vitest fails stories with contract errors', { timeout: 180000 }, async () => {
      const storyNames = ['ErrorInvalid', 'ErrorNeverAnswers', 'ErrorValid', 'TodoInvalid', 'OffInvalid'];
      const story = await runStoriesWithVitest(
        { MOKAPI_DASHBOARD: dashboard, MOKAPI_DEFAULT_VALIDATION: 'true' },
        join(directory, 'vitest.json'),
        storyNames,
      );
      const failures = (name) => story(name).failureMessages.join('\n');
      story('ErrorInvalid').expect('failed');
      assert.match(failures('ErrorInvalid'), /Mokapi: 1 response does not match the contract\./);
      // Vitest's own timeout would say "Test timed out", so this shows the addon's limit fits into the default.
      story('ErrorNeverAnswers').expect('failed');
      assert.match(failures('ErrorNeverAnswers'), /Mokapi validation did not finish within 4 s \(GET \/api\/profile\)\./);
      for (const name of ['ErrorValid', 'TodoInvalid', 'OffInvalid']) story(name).expect('passed');
    });

    await scenario('defaultTest error fails a story without its own test parameter', async (page) => {
      await openValidated(page, 'profile--invalid', failingStorybook);
      await assertStoryFails(page, /Mokapi: 1 response does not match the contract\./);
      await reportBadge(page).waitFor();
      await assertBadgeTooltip(page, TEST_MODE_TEXTS.error);
    });
  } finally {
    if (failureDirectory) console.error(`E2E failure artifacts kept in ${failureDirectory}`);
    if (browser) await browser.close();
    await Promise.all(storybooks.map((storybook) => storybook.stop()));
    if (stopMokapi) await stopMokapi();
    await rm(directory, { recursive: true, force: true });
  }
});
