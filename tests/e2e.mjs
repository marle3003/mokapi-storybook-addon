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

// Storybook's error display of the preview: the first line of the message and the rest.
const errorDisplay = (frame) => frame.locator('body.sb-show-errordisplay');
const errorTextOf = async (frame) =>
  `${await frame.locator('#error-message').textContent()}\n${await frame.locator('#error-stack').textContent()}`;

async function assertStoryFails(page, message) {
  await errorDisplay(previewFrame(page)).waitFor();
  await eventually(async () => assert.match(await errorTextOf(previewFrame(page)), message));
  assert.equal((await finishedStory(page)).status, 'error');
}

async function assertStoryStaysGreen(page) {
  const finished = await finishedStory(page);
  assert.equal(finished.status, 'success');
  assert.equal(await errorDisplay(previewFrame(page)).count(), 0);
  return finished;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const operationLink = (page, status) => entries(page, status).getByTestId('mokapi-operation');
const testModeLine = (page) => page.getByTestId('mokapi-test-mode');
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

    for (const [id, mode] of [['profile--error-invalid', 'error'], ['profile--todo-invalid', 'todo'], ['profile--off-invalid', 'off']]) {
      await scenario(`the panel shows the test mode ${mode} of the story`, async (page) => {
        await openValidated(page, id);
        await showsText(testModeLine(page), TEST_MODE_TEXTS[mode]);
      });
    }

    await scenario('an invalid test parameter shows the default test mode and a configuration notice', async (page) => {
      await openValidated(page, 'profile--invalid-test-parameter');
      await showsText(testModeLine(page), TEST_MODE_TEXTS.todo);
      await notice(page, "Mokapi: parameters.mokapi.test must be 'error', 'todo' or 'off'.").waitFor();
      await assertStoryStaysGreen(page);
    });

    await scenario('the panel shows no test mode with validation off or for a disabled story', async (page) => {
      await openValidated(page, 'profile--error-disabled');
      await assertStoryStaysGreen(page);
      assert.equal(await testModeLine(page).count(), 0);

      await openValidated(page, 'profile--error-invalid', storybook);
      await page.getByText(/Turn on validation/).waitFor();
      assert.equal(await testModeLine(page).count(), 0);
    });

    await scenario('with test error a response that does not match the contract fails the story', async (page) => {
      await openValidated(page, 'profile--error-invalid');
      const url = escapeRegExp(dashboardOperationUrl(dashboard, 'Profile%20API/api/profile/get'));
      await assertStoryFails(page, new RegExp(
        `Mokapi: 1 response does not match the contract\\.\\n+GET /api/profile -> GET /api/profile \\(${url}\\)\\n\\s+response\\.body: required properties are missing: email`,
      ));
      await entries(page, 'invalid').waitFor();
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
      await assertStoryFails(page, /Mokapi: 1 response does not match the contract\./);
      await openMokapiPanel(page);
      assert.equal(await entries(page, 'invalid').count(), 1);
    });

    await scenario('on a Docs page a story with test error shows the error in its frame', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'docs-test-mode--docs', docs: true });
      const story = previewFrame(page).frameLocator('#iframe--docs-test-mode--error-invalid').first();
      await errorDisplay(story).waitFor();
      await eventually(async () => assert.match(await errorTextOf(story), /Mokapi: 1 response does not match the contract\./));
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
      await showsText(testModeLine(page), TEST_MODE_TEXTS.error);
    });
  } finally {
    if (failureDirectory) console.error(`E2E failure artifacts kept in ${failureDirectory}`);
    if (browser) await browser.close();
    await Promise.all(storybooks.map((storybook) => storybook.stop()));
    if (stopMokapi) await stopMokapi();
    await rm(directory, { recursive: true, force: true });
  }
});
