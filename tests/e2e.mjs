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
  warning: 'Test mode: warning. Contract errors are reported as warnings, the story stays green.',
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

const STOP_GRACE_MS = 5000;

// SIGTERM, then SIGKILL after the grace period. The timer is cancelled when the process exits,
// so it doesn't keep the event loop alive. SIGKILL is sent in any case, because a Storybook
// leader can exit on SIGTERM while other processes of its group still hold the port.
async function stopProcess(stopped, kill) {
  kill('SIGTERM');
  const grace = new AbortController();
  await Promise.race([stopped, setTimeout(STOP_GRACE_MS, undefined, { signal: grace.signal })]);
  grace.abort();
  kill('SIGKILL');
  await stopped;
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
  const stop = () => stopProcess(stopped, (signal) => child.kill(signal));
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
  const stop = () => stopProcess(stopped, killGroup);
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
const partialText = (page) => page.getByTestId('mokapi-partial');
const PARTIAL_TEXT = 'Partial responses: missing properties are not checked.';
const rerunButton = (page) => page.getByTestId('mokapi-rerun');
const entryDetails = (entry) => entry.getByTestId('mokapi-details');
const toggleDetails = (entry) => entryDetails(entry).locator('summary').click();
// The badge exists twice per row, in the row's meta and in the heading of the response details.
const entryBadge = (entry) => entry.getByTestId('mokapi-entry-meta').getByTestId('mokapi-status-badge');
const responseBadge = (entry) => entryDetails(entry).getByTestId('mokapi-status-badge');
// The method badge exists twice per entry too. The row's badge comes first in the DOM, the details follow it.
const entryMethodBadge = (entry) => entry.getByTestId('mokapi-method-badge').first();
const requestBadge = (entry) => entryDetails(entry).getByTestId('mokapi-method-badge');
const fontFamilyOf = (locator) => locator.evaluate((element) => getComputedStyle(element).fontFamily);
const colorOf = (locator) => locator.evaluate((element) => getComputedStyle(element).color);
const backgroundColorOf = (locator) => locator.evaluate((element) => getComputedStyle(element).backgroundColor);
const entryTime = (entry) => entry.getByTestId('mokapi-entry-time');
const EMPTY_LIST_TEXT = 'No responses validated since this story was mounted.';
const DISABLED_HINT_TEXT = 'Validation is disabled for this story with parameters.mokapi.disable.';
const DOCS_URL = 'https://mokapi.io/docs/integrations/storybook';
const HELP_LINK_TEXT = 'Learn more about the Mokapi addon';
const HELP_ICON_LABEL = 'Mokapi addon documentation';
// The hint replaces toolbar and list; the text is read by test id, so that it is one string across its `<code>`.
const hintText = (page) => page.getByTestId('mokapi-hint');
const helpLink = (page) => page.getByRole('link', { name: HELP_LINK_TEXT });
const helpIcon = (page) => page.getByTestId('mokapi-help');
const dashboardLink = (page) => page.getByRole('link', { name: 'Open Mokapi dashboard' });
const fontOf = (locator) => locator.evaluate((element) => {
  const { fontWeight, fontSize } = getComputedStyle(element);
  return { fontWeight, fontSize };
});

// Only the hint is shown: no toolbar with badge or Rerun, no empty-list text, no notice, no dashboard link.
async function assertOnlyDisabledHint(page) {
  await showsText(hintText(page), DISABLED_HINT_TEXT);
  assert.equal(await hintText(page).locator('code').textContent(), 'parameters.mokapi.disable');
  assert.equal(await rerunButton(page).count(), 0);
  assert.equal(await reportBadge(page).count(), 0);
  assert.equal(await page.getByText('No responses validated').count(), 0);
  assert.equal(await dashboardLink(page).count(), 0);
}

// The link sits below the hint text, opens the docs overview in a new tab and is the only link of the panel.
async function assertHelpLinkBelow(page) {
  const link = helpLink(page);
  await link.waitFor();
  assert.equal(await link.getAttribute('href'), DOCS_URL);
  assert.equal(await link.getAttribute('target'), '_blank');
  const text = await boxOf(hintText(page));
  assert.ok((await boxOf(link)).y >= text.y + text.height, 'the help link is below the hint text');
}

// Text and link together sit in the middle of the panel (2px), on both axes. The panel is the box the hint fills.
async function assertHintCentered(page) {
  const text = await boxOf(hintText(page));
  const link = await boxOf(helpLink(page));
  const panel = await hintText(page).evaluate((element) => {
    const { x, y, width, height } = element.parentElement.parentElement.getBoundingClientRect();
    return { x, y, width, height };
  });
  const left = Math.min(text.x, link.x);
  const right = Math.max(text.x + text.width, link.x + link.width);
  const top = text.y;
  const bottom = link.y + link.height;
  assertSameEdge((left + right) / 2, panel.x + panel.width / 2, 'x of the hint', 2);
  assertSameEdge((top + bottom) / 2, panel.y + panel.height / 2, 'y of the hint', 2);
  assert.deepEqual(await fontOf(hintText(page)), { fontWeight: '700', fontSize: '13px' });
}

// `exact`, because `OK` would also match "Mokapi".
async function assertBadgeTooltip(trigger, text) {
  const page = trigger.page();
  await trigger.hover();
  await page.getByText(text, { exact: true }).waitFor();
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

// Opens the context menu of a sidebar row (story or component) and returns the menu. Stories list "Copy story name",
// every row with a test provider has the "Run component tests" region.
const openContextMenu = async (page, id) => {
  await sidebarRow(page, id).hover();
  await sidebarRow(page, id).getByRole('button', { name: 'Open context menu' }).click();
  const menu = page.locator('.sb-list', { hasText: /Copy story name|Run component tests/ });
  await menu.waitFor();
  return menu;
};

// The test provider region is the last group of the menu, below the links; the row "Contract" is in it.
const contractRowOf = async (page, id, name) => {
  const region = (await openContextMenu(page, id)).locator('> div').last();
  await region.getByText('Contract', { exact: true }).waitFor({ timeout: 3000 });
  return region.getByRole('button', { name, exact: true });
};

const NO_RESULT_TOOLTIP = 'Validate with Mokapi or run tests to see results';
const PASSED_TOOLTIP = 'All responses match the contract.';

const boxOf = async (locator) => {
  const box = await locator.boundingBox();
  assert.ok(box, 'the element has a bounding box');
  return box;
};
const rightOf = async (locator) => { const box = await boxOf(locator); return box.x + box.width; };
const assertSameEdge = (actual, expected, what, tolerance = 1) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: Mokapi ${actual}px, expected ${expected}px`);

// The Mokapi row has to line up with the Interactions row of addon-vitest: same text x, same button right edge (1px).
async function assertLaidOutLikeInteractionsRow(page, id) {
  const menu = await openContextMenu(page, id);
  const testProviderRegion = menu.locator('> div').last();
  await testProviderRegion.getByText('Contract', { exact: true }).waitFor({ timeout: 3000 });
  await testProviderRegion.getByText('Run component tests', { exact: true }).waitFor({ timeout: 3000 });

  const mokapiRow = testProviderRegion.getByRole('listitem').filter({ hasText: 'Contract' });
  const interactionsRow = testProviderRegion.getByRole('listitem').filter({ hasText: 'Interactions' });

  // The row texts start at the same x.
  assertSameEdge(
    (await boxOf(mokapiRow.getByText('Contract', { exact: true }))).x,
    (await boxOf(interactionsRow.getByText('Interactions', { exact: true }))).x,
    'left edge of the row text');
  // The status buttons end at the same x.
  assertSameEdge(
    await rightOf(mokapiRow.getByRole('button')),
    await rightOf(interactionsRow.getByRole('button')),
    'right edge of the status button');
}

// The Run tests widget (Storybook's testing module, dev server only) is a card below the sidebar. Every test provider
// has a box in it, found by its id: addon-vitest's rows (Interactions, Coverage) and Mokapi's row "Contract".
const mokapiModule = (page) => page.locator('[data-module-id="mokapi/test-provider"]');
const vitestModule = (page) => page.locator('[data-module-id="storybook/test/test-provider"]');
const expandTestingModule = async (page) => {
  await page.getByRole('button', { name: 'Expand testing module' }).click();
  await mokapiModule(page).getByText('Contract', { exact: true }).waitFor({ timeout: 3000 });
};
const widgetContractButton = (page, name) => mokapiModule(page).getByRole('button', { name, exact: true });
const boxShadowOf = (locator) => locator.evaluate((element) => getComputedStyle(element).boxShadow);

// The Contract row of the widget has to read as one more row of addon-vitest's block: the text and the button line up
// with the Coverage row (1px) and the gap to it is the one between Interactions and Coverage (1px). The card grows
// while it expands, so the measurements are repeated until they are taken on the settled card.
async function assertContractRowLaidOutLikeCoverageRow(page) {
  const rowOf = (module, text) => module.getByRole('listitem').filter({ hasText: text });
  const coverageRow = rowOf(vitestModule(page), 'Coverage');
  const interactionsRow = rowOf(vitestModule(page), 'Interactions');
  const contractRow = rowOf(mokapiModule(page), 'Contract');
  const gapBetween = async (above, below) => (await boxOf(below)).y - ((await boxOf(above)).y + (await boxOf(above)).height);
  await eventually(async () => {
    assertSameEdge(
      (await boxOf(contractRow.getByText('Contract', { exact: true }))).x,
      (await boxOf(coverageRow.getByText('Coverage', { exact: true }))).x,
      'left edge of the row text');
    assertSameEdge(
      await rightOf(contractRow.getByRole('button')),
      await rightOf(coverageRow.getByRole('button')),
      'right edge of the status button');
    assertSameEdge(
      await gapBetween(coverageRow, contractRow),
      await gapBetween(interactionsRow, coverageRow),
      'gap to the row above');
  }, 5000);
}
const dashboardOperationUrl = (dashboard, path) => `${dashboard}/dashboard/http/services/${path}`;

// Runs the fixture's stories with @storybook/addon-vitest (Vitest browser mode, Vitest's default testTimeout)
// and returns Vitest's JSON result of the stories whose export names are given.
async function runStoriesWithVitest(env, outputFile, storyNames) {
  const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const pattern = storyNames.map((name) => name.replace(/(?<=.)([A-Z])/g, ' $1')).join('|');
  const child = spawn(process.execPath, [
    cli, 'run', 'TestMode.stories', 'Profile.stories', '--reporter=json', `--outputFile=${outputFile}`, '--testNamePattern', pattern,
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

// Validation runs after the response, so proving that nothing more arrives needs a fixed window.
const QUIET_WINDOW_MS = 1500;

async function assertNothingSent(requests) {
  await setTimeout(QUIET_WINDOW_MS);
  assert.equal(requests.length, 0);
}

async function assertCountStays(locator, count) {
  await setTimeout(QUIET_WINDOW_MS);
  assert.equal(await locator.count(), count);
}

// The animation of the `Animated` story runs 8 s, but waitForAnimations gives up after 5 s, so the old
// render leaves `completing` 5 s after it started. Switch late enough that the re-render finishes
// clearly after it, but before the old render leaves `completing`.
const SWITCH_INTO_COMPLETING_MS = 1500;

test('Storybook user validates the MSW responses of a story against the OpenAPI contract', { timeout: 600000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mokapi-storybook-e2e-'));
  let failureDirectory;
  let stopMokapi;
  let browser;
  let testFailed = false;
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
    // Its own timeout makes a hanging scenario fail by name instead of using up the budget of the whole test.
    // MSW names the request in the same console message, with the line breaks of its own format.
    // A missing `Accept: msw/passthrough` marker shows up here, whatever onUnhandledRequest is set to.
    const isUnhandledValidationRequest = (line) =>
      line.includes('[MSW]') && line.includes('intercepted a request without a matching request handler') && line.includes(VALIDATE_PATH);
    const scenario = (name, run, contextOptions = {}) => t.test(name, { timeout: 60000 }, async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1600 }, locale: 'en-US', ...contextOptions });
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
        const unhandled = consoleLines.find(isUnhandledValidationRequest);
        if (unhandled) throw new Error(`MSW treated the addon's validation request as unhandled: ${unhandled}`);
      } catch (error) {
        // A failed subtest doesn't reject into the outer test, so it marks the test as failed itself.
        testFailed = true;
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
      await assertCountStays(entries(page), 1);
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
      await setTimeout(SWITCH_INTO_COMPLETING_MS);
      await switchValidation(page, 'on');
      // The remount is the second `loading` after the switch (the first is the re-render).
      await preview.waitForFunction((from) => {
        const rest = window.__events.slice(from);
        return rest.indexOf('loading', rest.indexOf('loading') + 1) > 0;
      }, beforeSwitch);
      await openMokapiPanel(page);
      await entries(page, 'valid').first().waitFor();
      await assertCountStays(entries(page), 1);
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
      await assertOnlyDisabledHint(page);
    });

    await scenario('passthrough responses are not validated', async (page) => {
      const sent = trackValidationRequests(page, dashboard);
      await open(page, { id: 'profile--passthrough', validation: true });
      await eventually(async () => assert.notEqual(await profileInPreview(page).textContent({ timeout: 1000 }), 'Loading...'));
      await openMokapiPanel(page);
      await assertNothingSent(sent);
      assert.equal(await entries(page).count(), 0);
      await page.getByText(EMPTY_LIST_TEXT).waitFor();
    });

    await scenario('switching the story and re-rendering it clear the list', async (page) => {
      await open(page, { id: 'profile--valid', validation: true });
      await openMokapiPanel(page);
      await entries(page, 'valid').waitFor();

      // Switching validation off and on renders the story again: one entry, not two.
      await switchValidationAndWait(page, 'off');
      // The panel remembers the last result of the story, so the request count proves the re-render and the remount ran.
      const sent = trackValidationRequests(page, dashboard);
      await switchValidationAndWait(page, 'on');
      await eventually(() => assert.equal(sent.length, 1));
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
      assert.equal(await link.textContent(), '/api/profile');
      assert.equal(await link.getAttribute('title'), 'GET /api/profile');
      assert.equal(await link.getByTestId('mokapi-method-badge').count(), 0);
      assert.equal(await entryMethodBadge(entries(page, 'valid')).textContent(), 'GET');
      assert.equal(await link.getAttribute('href'), dashboardOperationUrl(dashboard, 'Profile%20API/api/profile/get'));
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await link.getAttribute('rel'), 'noreferrer');

      await openValidated(page, 'profile--invalid');
      assert.equal(await operationLink(page, 'invalid').textContent(), '/api/profile');
      assert.equal(await operationLink(page, 'invalid').getAttribute('title'), 'GET /api/profile');
      assert.equal(
        await operationLink(page, 'invalid').getAttribute('href'),
        dashboardOperationUrl(dashboard, 'Profile%20API/api/profile/get'),
      );
    });

    await scenario('the operation link shows the URL, titles the path template and encodes its braces', async (page) => {
      await openValidated(page, 'profile--path-pattern');
      const link = operationLink(page, 'valid');
      await link.waitFor();
      assert.equal(await link.textContent(), '/api/users/42');
      assert.equal(await link.getAttribute('title'), 'GET /api/users/{id}');
      assert.equal(await link.getByTestId('mokapi-method-badge').count(), 0);
      assert.equal(await entryMethodBadge(entries(page, 'valid')).textContent(), 'GET');
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

    for (const [id, mode] of [['profile--error-invalid', 'error'], ['profile--warning-invalid', 'warning']]) {
      await scenario(`the badge tooltip shows the test mode ${mode} of the story`, async (page) => {
        await openValidated(page, id);
        await reportBadge(page).waitFor();
        await assertBadgeTooltip(reportBadge(page), TEST_MODE_TEXTS[mode]);
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
      await assertBadgeTooltip(reportBadge(page), TEST_MODE_TEXTS.warning);
      await notice(page, "Mokapi: parameters.mokapi.test must be 'error', 'warning' or 'off'.").waitFor();
      await assertStoryStaysGreen(page);
    });

    await scenario('a partial story with missing required properties passes and says that they are not checked', async (page) => {
      await openValidated(page, 'profile--partial');
      await showsText(reportBadge(page), 'PARTIAL');
      // theme.color.positive of the light theme, the color of PASS
      assert.equal(await backgroundColorOf(reportBadge(page)), 'rgb(102, 191, 60)');
      await showsText(partialText(page), PARTIAL_TEXT);
      await entries(page, 'valid').waitFor();
      assert.equal(await entries(page, 'invalid').count(), 0);
      await assertStoryStaysGreen(page);
      await assertSidebarStatus(page, 'profile--partial', 'Success');
    });

    await scenario('a story with partial false reports the missing required property as invalid', async (page) => {
      await openValidated(page, 'profile--partial-off');
      await showsText(reportBadge(page), 'WARN');
      await entries(page, 'invalid').waitFor();
      assert.match(await entries(page, 'invalid').textContent(), /required properties are missing: email/);
      assert.equal(await partialText(page).count(), 0);
    });

    await scenario('an invalid partial parameter shows a configuration notice', async (page) => {
      await openValidated(page, 'profile--invalid-partial-parameter');
      await notice(page, 'Mokapi: parameters.mokapi.partial must be true or false.').waitFor();
      await showsText(reportBadge(page), 'WARN');
      assert.equal(await partialText(page).count(), 0);
    });

    await scenario('a disabled story shows only the disable hint, whatever the test mode, and stays green', async (page) => {
      await openValidated(page, 'profile--error-disabled');
      await assertStoryStaysGreen(page);
      await assertOnlyDisabledHint(page);
      assert.equal(await testModeOffText(page).count(), 0);
    });

    await scenario('a disabled story shows the disable hint with validation off, not the toggle hint', async (page) => {
      await openValidated(page, 'profile--disabled', storybook);
      await assertOnlyDisabledHint(page);
      assert.equal(await page.getByText(/Turn on validation/).count(), 0);
    });

    await scenario('a disabled story without a worker shows the disable hint, not the worker notice', async (page) => {
      await openValidated(page, 'profile--disabled-without-worker');
      await assertOnlyDisabledHint(page);
      assert.equal(await notice(page, /MSW worker not found/).count(), 0);
    });

    await scenario('the disable hint wins over an earlier panel result', async (page) => {
      await openValidated(page, 'profile--error-invalid');
      await entries(page, 'invalid').waitFor();
      await page.locator('[id="profile--error-disabled"]').click();
      await assertOnlyDisabledHint(page);
      assert.equal(await entries(page).count(), 0);
    });

    await scenario('both hints are centered, bold and 13px, with the help link below the text', async (page) => {
      await openValidated(page, 'profile--disabled');
      await assertOnlyDisabledHint(page);
      await assertHelpLinkBelow(page);
      await assertHintCentered(page);

      await openValidated(page, 'profile--valid', storybook);
      await showsText(hintText(page), 'Turn on validation with the "Validate with Mokapi" toggle in the toolbar.');
      await assertHelpLinkBelow(page);
      await assertHintCentered(page);
    });

    await scenario('the toolbar of a validated story has a help icon left of the dashboard link', async (page) => {
      await openValidated(page, 'profile--valid');
      await entries(page, 'valid').waitFor();
      const icon = helpIcon(page);
      assert.equal(await icon.getAttribute('aria-label'), HELP_ICON_LABEL);
      assert.equal(await icon.getAttribute('href'), DOCS_URL);
      assert.equal(await icon.getAttribute('target'), '_blank');
      assert.ok(await rightOf(icon) <= (await boxOf(dashboardLink(page))).x, 'the help icon is left of the dashboard link');
      assert.equal(await helpLink(page).count(), 0);
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
      await showsText(reportHeadline(page), '1 response does not match the contract.');

      await openValidated(page, 'profile--warning-invalid');
      await showsText(reportBadge(page), 'WARN');
      await showsText(reportHeadline(page), '1 response does not match the contract.');

      await openValidated(page, 'profile--error-valid');
      await showsText(reportBadge(page), 'PASS');
      assert.equal(await reportHeadline(page).count(), 0);
    });

    // Not in the contract, no request and no worker: nothing was checked, and Storybook still reports the story as passed.
    await scenario('the badge shows SKIP with its headline when no response was checked against the contract', async (page) => {
      const noResponse = 'No response was checked against the contract.';
      const noWorker = 'MSW worker not found: `context.msw` is missing. Use `mswLoader` or set `context.msw` in your loader.';
      for (const [id, mode, headline] of [['profile--not-in-contract', 'warning', noResponse], ['profile--error-no-request', 'error', noResponse], ['profile--error-no-worker', 'error', noWorker]]) {
        await openValidated(page, id);
        await showsText(reportBadge(page), 'SKIP');
        await showsText(reportHeadline(page), headline);
        await assertBadgeTooltip(reportBadge(page), TEST_MODE_TEXTS[mode]);
        await assertStoryStaysGreen(page);
        await assertNoSidebarStatus(page, id);
      }
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
      await assertSidebarStatus(page, 'profile--error-invalid', 'Success');
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

    await scenario('an entry row shows kind, method badge, URL, status badge and time, and the errors without expanding', async (page) => {
      await openValidated(page, 'profile--invalid');
      const invalid = entries(page, 'invalid');
      await invalid.waitFor();
      const text = await invalid.textContent();
      assert.match(text, /invalid/);
      assert.match(text, /GET \/api\/profile/);
      const methodBadge = entryMethodBadge(invalid);
      assert.equal(await methodBadge.textContent(), 'GET');
      assert.equal(await methodBadge.getAttribute('aria-label'), null);
      // theme.color.secondary of the light theme
      assert.equal(await backgroundColorOf(methodBadge), 'rgb(0, 109, 235)');
      const badge = entryBadge(invalid);
      assert.equal(await badge.textContent(), '200');
      assert.equal(await badge.getAttribute('aria-label'), '200 OK');
      assert.equal(await backgroundColorOf(badge), 'rgb(102, 191, 60)');
      await assertBadgeTooltip(badge, 'OK');
      // The badges set their own font, they don't inherit the mono font of the URL.
      assert.match(await fontFamilyOf(methodBadge), /^"?Nunito Sans/);
      assert.match(await fontFamilyOf(badge), /^"?Nunito Sans/);
      // The English locale would show AM or PM without the fixed format.
      assert.match(await entryTime(invalid).textContent(), /^\d{2}:\d{2}:\d{2}$/);
      assert.doesNotMatch(text, /\b(AM|PM)\b/);
      assert.ok(await invalid.getByText(/required properties are missing: email/).isVisible());
      assert.equal(await invalid.getByText('(empty)').isVisible(), false);
      // theme.background.warning of the light theme
      assert.equal(await backgroundColorOf(invalid), 'rgb(255, 249, 235)');
    });

    await scenario('the method badge, the status badge and the invalid row follow the dark manager theme', async (page) => {
      await openValidated(page, 'profile--invalid');
      const invalid = entries(page, 'invalid');
      await invalid.waitFor();
      // theme.color.secondary of the dark theme
      assert.equal(await backgroundColorOf(entryMethodBadge(invalid)), 'rgb(71, 157, 255)');
      // theme.color.positive of the dark theme
      assert.equal(await backgroundColorOf(entryBadge(invalid)), 'rgb(102, 191, 60)');
      // the dark fallback of the invalid row in src/manager.tsx
      assert.equal(await backgroundColorOf(invalid), 'rgba(255, 68, 0, 0.07)');
    }, { colorScheme: 'dark' });

    await scenario('Request and Response are collapsed and show headers and pretty-printed bodies when expanded', async (page) => {
      await openValidated(page, 'profile--valid');
      const valid = entries(page, 'valid');
      await valid.waitFor();
      assert.equal(await entryDetails(valid).getAttribute('open'), null);
      await toggleDetails(valid);
      await entryDetails(valid).locator('strong', { hasText: /^Request$/ }).waitFor();
      const get = await entryDetails(valid).textContent();
      assert.equal(await requestBadge(valid).textContent(), 'GET');
      assert.match(get, /\(empty\)/);
      assert.match(get, /content-type: application\/json/);
      assert.match(get, /\{\s*\n\s+"name": "Jane Doe"/);
      assert.match(get, /200/);
      const heading = responseBadge(valid);
      await entryDetails(valid).locator('strong', { hasText: /^Response$/ }).waitFor();
      assert.equal(await heading.textContent(), '200');
      assert.equal(await heading.getAttribute('aria-label'), '200 OK');
      await assertBadgeTooltip(heading, 'OK');
      assert.match(await fontFamilyOf(requestBadge(valid)), /^"?Nunito Sans/);
      assert.match(await fontFamilyOf(heading), /^"?Nunito Sans/);

      await openValidated(page, 'profile--post-valid');
      const post = entries(page, 'valid');
      await post.waitFor();
      await toggleDetails(post);
      const posted = await entryDetails(post).textContent();
      assert.equal(await requestBadge(post).textContent(), 'POST');
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

    await scenario('a story with an error or a warning gets a Mokapi status in the sidebar, a passed one the success status', async (page) => {
      await openWithClearedStatuses(page, 'profile--error-invalid');
      await showsText(reportHeadline(page), '1 response does not match the contract.');
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');

      await openValidated(page, 'profile--warning-invalid');
      await showsText(reportBadge(page), 'WARN');
      await assertSidebarStatus(page, 'profile--warning-invalid', 'Warning');

      // A passed story has the success status. That a passed check replaces the status of an earlier failing run
      // of the same story is covered by the Rerun scenario.
      await page.locator('[id="profile--error-valid"]').click();
      await showsText(reportBadge(page), 'PASS');
      await assertSidebarStatus(page, 'profile--error-valid', 'Success');

      for (const id of ['profile--off-invalid', 'profile--error-disabled']) {
        await page.locator(`[id="${id}"]`).click();
        await assertStoryStaysGreen(page);
        await assertNoSidebarStatus(page, id);
      }
    });

    await scenario('the Mokapi status stays when the story is switched and a story without validation gets none', async (page) => {
      await openWithClearedStatuses(page, 'profile--error-invalid');
      await showsText(reportHeadline(page), '1 response does not match the contract.');
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
      // Scoped to the menu, because the Contract row of the Run tests widget has a button with the same name.
      await (await contractRowOf(page, 'profile--error-invalid', 'Mokapi: Error (1 invalid response)')).click();
      await page.getByRole('tab', { name: /^Mokapi/, selected: true }).waitFor();
      await showsText(reportHeadline(page), '1 response does not match the contract.');
    });

    await scenario('the context menu of a story shows the Mokapi report in the test provider region, not as a status link', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'profile--error-invalid' });
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');

      await sidebarRow(page, 'profile--error-invalid').hover();
      await sidebarRow(page, 'profile--error-invalid').getByRole('button', { name: 'Open context menu' }).click();
      // Storybook's TooltipLinkList (`.sb-list`) renders one div per group: the first holds the links (Open in
      // editor, Copy story name and one link per status), the last one the sections of the registered test providers.
      const menu = page.locator('.sb-list', { hasText: 'Copy story name' });
      await menu.waitFor();
      const testProviderRegion = menu.locator('> div').last();

      // addon-vitest keeps its own statuses out of the status links (`sidebarContextMenu: false`), Mokapi has to do the same.
      assert.equal(await menu.getByLabel(/^Test status for Mokapi/).count(), 0);

      // The Mokapi section of the test provider `mokapi/test-provider` is one row "Contract" with no
      // heading. Its button shows the number of invalid responses before the status dot, is named after the status
      // and the number, and has the headline as tooltip.
      await testProviderRegion.getByText('Contract', { exact: true }).waitFor({ timeout: 3000 });
      assert.equal(await menu.getByText('Mokapi contract validation').count(), 0);
      const button = testProviderRegion.getByRole('button', { name: 'Mokapi: Error (1 invalid response)', exact: true });
      await button.waitFor({ timeout: 3000 });
      await showsText(button, '1');
      await button.hover();
      await page.getByText('1 response does not match the contract.', { exact: true }).waitFor({ timeout: 3000 });
    });

    await scenario('the context menu row of a story shows the number of invalid responses after a browser reload', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'profile--error-invalid' });
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');

      // A new page load empties the manager's panel state. The status survives on the dev server (the status store
      // leader), and the story with the status is not rendered again, because another story is selected.
      await openStory(page, validatingStorybook.url, { id: 'profile--valid' });
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');

      await sidebarRow(page, 'profile--error-invalid').hover();
      await sidebarRow(page, 'profile--error-invalid').getByRole('button', { name: 'Open context menu' }).click();
      const menu = page.locator('.sb-list', { hasText: 'Copy story name' });
      await menu.waitFor();
      const button = menu.locator('> div').last().getByRole('button', { name: 'Mokapi: Error (1 invalid response)', exact: true });
      await button.waitFor({ timeout: 3000 });
      await showsText(button, '1');
    });

    await scenario('the context menu row of a passed story is green, has no number and opens the Mokapi panel', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'profile--valid' });
      await assertSidebarStatus(page, 'profile--valid', 'Success');
      assert.equal(await page.getByRole('tab', { name: /^Mokapi/, selected: true }).count(), 0);

      const button = await contractRowOf(page, 'profile--valid', 'Mokapi: Passed');
      await button.waitFor({ timeout: 3000 });
      assert.equal(await button.isDisabled(), false);
      await showsText(button, '');
      await button.hover();
      await page.getByText(PASSED_TOOLTIP, { exact: true }).waitFor({ timeout: 3000 });
      await button.click();
      await page.getByRole('tab', { name: /^Mokapi/, selected: true }).waitFor();
    });

    await scenario('the context menu row of a story without result is gray, has no number and is disabled', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'profile--off-invalid' });
      await assertNoSidebarStatus(page, 'profile--off-invalid');

      const button = await contractRowOf(page, 'profile--off-invalid', 'Mokapi: No result');
      await button.waitFor({ timeout: 3000 });
      assert.equal(await button.isDisabled(), true);
      await showsText(button, '');
      await button.hover();
      await page.getByText(NO_RESULT_TOOLTIP, { exact: true }).waitFor({ timeout: 3000 });
    });

    await scenario('a skipped story sets no status and shows the gray context menu row', async (page) => {
      await openValidated(page, 'profile--not-in-contract');
      await showsText(reportBadge(page), 'SKIP');
      await assertNoSidebarStatus(page, 'profile--not-in-contract');

      const button = await contractRowOf(page, 'profile--not-in-contract', 'Mokapi: No result');
      await button.waitFor({ timeout: 3000 });
      assert.equal(await button.isDisabled(), true);
    });

    await scenario('the context menu row of the green story is still green after a browser reload', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'profile--valid' });
      await assertSidebarStatus(page, 'profile--valid', 'Success');

      // A new page load empties the manager's panel state. The status survives on the dev server.
      await openStory(page, validatingStorybook.url, { id: 'profile--off-invalid' });
      await assertSidebarStatus(page, 'profile--valid', 'Success');
      const button = await contractRowOf(page, 'profile--valid', 'Mokapi: Passed');
      await button.waitFor({ timeout: 3000 });
      assert.equal(await button.isDisabled(), false);
    });

    await scenario('the context menu row of a component without result is gray and disabled', async (page) => {
      await openValidated(page, 'profile--error-valid');
      await showsText(reportBadge(page), 'PASS');
      await clearAllStatusesButton(page).click();
      await assertNoSidebarStatus(page, 'profile--error-valid');

      const button = await contractRowOf(page, 'profile', 'Mokapi: No result');
      await button.waitFor({ timeout: 3000 });
      assert.equal(await button.isDisabled(), true);
    });

    await scenario('the context menu row of a component shows the worst status of its stories and opens the first error', async (page) => {
      await openWithClearedStatuses(page, 'profile--valid');
      await assertSidebarStatus(page, 'profile--valid', 'Success');
      await page.locator('[id="profile--error-invalid"]').click();
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');
      await page.locator('[id="profile--warning-invalid"]').click();
      await assertSidebarStatus(page, 'profile--warning-invalid', 'Warning');
      // openWithClearedStatuses opened the Mokapi panel; select another one, so the click has to open it.
      await page.getByRole('tab', { name: /^Controls/ }).click();
      assert.equal(await page.getByRole('tab', { name: /^Mokapi/, selected: true }).count(), 0);

      // One invalid response of the error story and one of the warning story.
      const button = await contractRowOf(page, 'profile', 'Mokapi: Error (2 invalid responses)');
      await button.waitFor({ timeout: 3000 });
      await showsText(button, '2');
      await button.hover();
      await page.getByText('Contract validation failed', { exact: true }).waitFor({ timeout: 3000 });
      await button.click();
      await page.getByRole('tab', { name: /^Mokapi/, selected: true }).waitFor();
      await eventually(async () => assert.match(page.url(), /path=\/story\/profile--error-invalid/));
    });

    await scenario('the context menu row of a component with passed stories only is green and opens the first passed story', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'docs--valid' });
      await assertSidebarStatus(page, 'docs--valid', 'Success');

      // Another story is selected, so the click has to select the story of the component.
      await openStory(page, validatingStorybook.url, { id: 'profile--off-invalid' });
      const button = await contractRowOf(page, 'docs', 'Mokapi: Passed');
      await button.waitFor({ timeout: 3000 });
      await button.hover();
      await page.getByText(PASSED_TOOLTIP, { exact: true }).waitFor({ timeout: 3000 });
      await button.click();
      await page.getByRole('tab', { name: /^Mokapi/, selected: true }).waitFor();
      await eventually(async () => assert.match(page.url(), /path=\/story\/docs--valid/));
    });

    await scenario('a docs entry has no Mokapi row in its context menu', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'docs--docs', docs: true });
      // Storybook renders no test provider region for a docs entry, its menu only has "Open in editor".
      await sidebarRow(page, 'docs--docs').hover();
      await sidebarRow(page, 'docs--docs').getByRole('button', { name: 'Open context menu' }).click();
      const menu = page.locator('.sb-list', { hasText: 'Open in editor' });
      await menu.waitFor();
      // Scoped to the menu, because the Run tests widget below the sidebar has its own Contract row.
      await assertCountStays(menu.getByText('Contract', { exact: true }), 0);
    });

    await scenario('the Mokapi row of the context menu is laid out like the Interactions row', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'profile--error-invalid' });
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');
      await assertLaidOutLikeInteractionsRow(page, 'profile--error-invalid');
    });

    await scenario('the gray Mokapi row of a story without result is laid out like the Interactions row', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'profile--off-invalid' });
      await assertNoSidebarStatus(page, 'profile--off-invalid');
      await assertLaidOutLikeInteractionsRow(page, 'profile--off-invalid');
    });

    await scenario('the green Mokapi row of a passed story is laid out like the Interactions row', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'profile--valid' });
      await assertSidebarStatus(page, 'profile--valid', 'Success');
      await assertLaidOutLikeInteractionsRow(page, 'profile--valid');
    });

    await scenario('Clear all statuses removes the Mokapi statuses and the Run tests widget has the Contract row instead of a heading', async (page) => {
      await openWithClearedStatuses(page, 'profile--error-invalid');
      // The headline is this render's report: the status is set after it, so Clear can't be overtaken.
      await showsText(reportHeadline(page), '1 response does not match the contract.');
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');

      await expandTestingModule(page);
      assert.equal(await mokapiModule(page).getByRole('listitem').count(), 1);
      assert.equal(await mokapiModule(page).getByText('Mokapi contract validation').count(), 0);

      await clearAllStatusesButton(page).click();
      await assertNoSidebarStatus(page, 'profile--error-invalid');
    });

    await scenario('Clear all statuses removes the success status and the row turns gray', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'profile--valid' });
      await assertSidebarStatus(page, 'profile--valid', 'Success');

      await clearAllStatusesButton(page).click();
      await assertNoSidebarStatus(page, 'profile--valid');
      const button = await contractRowOf(page, 'profile--valid', 'Mokapi: No result');
      await button.waitFor({ timeout: 3000 });
      assert.equal(await button.isDisabled(), true);
    });

    // The Run tests widget below the sidebar. The statuses are the ones of the sidebar, so these scenarios prepare
    // them like the context menu scenarios do.
    await scenario('the Run tests widget shows the row Contract and no Mokapi contract validation heading', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'profile--off-invalid' });
      await expandTestingModule(page);
      assert.equal(await mokapiModule(page).getByRole('listitem').count(), 1);
      assert.equal(await mokapiModule(page).getByText('Mokapi contract validation').count(), 0);
    });

    // The checkbox only shows whether a test run checks contracts, so it is disabled and has no accessible state
    // of its own: its name comes from the label, the tooltip explains the state.
    const assertContractCheckbox = async (page, storybookUnderTest, { checked, tooltip }) => {
      await openStory(page, storybookUnderTest.url, { id: 'profile--off-invalid' });
      await expandTestingModule(page);
      const checkbox = mokapiModule(page).getByRole('checkbox', { name: 'Contract' });
      assert.equal(await checkbox.isDisabled(), true);
      assert.equal(await checkbox.isChecked(), checked);
      await mokapiModule(page).getByText('Contract', { exact: true }).hover();
      await page.getByText(tooltip, { exact: true }).waitFor({ timeout: 3000 });
    };

    await scenario('the Contract checkbox of the Run tests widget is disabled and empty without defaultValidation', async (page) => {
      await assertContractCheckbox(page, storybook, {
        checked: false,
        tooltip: 'Contract validation is off in test runs. Set defaultValidation: true to check contracts.',
      });
    });

    await scenario('the Contract checkbox of the Run tests widget is disabled and checked with defaultValidation', async (page) => {
      await assertContractCheckbox(page, validatingStorybook, {
        checked: true,
        tooltip: 'Contract validation runs with the tests (defaultValidation is on).',
      });
    });

    await scenario('the Run tests widget has no divider between addon-vitest rows and Contract', async (page) => {
      await openStory(page, validatingStorybook.url, { id: 'profile--off-invalid' });
      await expandTestingModule(page);
      // Storybook draws the divider as the box-shadow of every box but the last one, and Mokapi's box is the last.
      assert.equal(await mokapiModule(page).evaluate((element) => element.nextElementSibling === null), true);
      assert.equal(await boxShadowOf(vitestModule(page)), 'none');
    });

    await scenario('the Contract row of the Run tests widget is laid out like the Coverage row', async (page) => {
      await openWithClearedStatuses(page, 'profile--error-invalid');
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');
      await expandTestingModule(page);
      await widgetContractButton(page, 'Mokapi: Error (1 invalid response)').waitFor({ timeout: 3000 });
      await assertContractRowLaidOutLikeCoverageRow(page);
    });

    await scenario('the Contract row of the Run tests widget is gray and disabled without a Mokapi result', async (page) => {
      await openWithClearedStatuses(page, 'profile--off-invalid');
      await expandTestingModule(page);
      const button = widgetContractButton(page, 'Mokapi: No result');
      await button.waitFor({ timeout: 3000 });
      assert.equal(await button.isDisabled(), true);
      await showsText(button, '');
      await button.hover();
      await page.getByText(NO_RESULT_TOOLTIP, { exact: true }).waitFor({ timeout: 3000 });
    });

    await scenario('the Contract row of the Run tests widget is green with passed stories only and opens the first passed story', async (page) => {
      await openWithClearedStatuses(page, 'profile--valid');
      await assertSidebarStatus(page, 'profile--valid', 'Success');
      // Another story is selected, so the click has to select the passed one. The panel is closed to see it opened.
      await page.locator('[id="profile--off-invalid"]').click();
      await eventually(async () => assert.match(page.url(), /path=\/story\/profile--off-invalid/));
      await page.getByRole('tab', { name: /^Controls/ }).click();
      assert.equal(await page.getByRole('tab', { name: /^Mokapi/, selected: true }).count(), 0);

      await expandTestingModule(page);
      const button = widgetContractButton(page, 'Mokapi: Passed');
      await button.waitFor({ timeout: 3000 });
      assert.equal(await button.isDisabled(), false);
      await showsText(button, '');
      await button.hover();
      await page.getByText(PASSED_TOOLTIP, { exact: true }).waitFor({ timeout: 3000 });
      await button.click();
      await page.getByRole('tab', { name: /^Mokapi/, selected: true }).waitFor();
      await eventually(async () => assert.match(page.url(), /path=\/story\/profile--valid/));
    });

    // Stories with an error and with a warning, the warning story selected, the panel closed.
    const openWithErrorAndWarning = async (page) => {
      await openWithClearedStatuses(page, 'profile--error-invalid');
      await assertSidebarStatus(page, 'profile--error-invalid', 'Error');
      await page.locator('[id="profile--warning-invalid"]').click();
      await assertSidebarStatus(page, 'profile--warning-invalid', 'Warning');
      await page.getByRole('tab', { name: /^Controls/ }).click();
      assert.equal(await page.getByRole('tab', { name: /^Mokapi/, selected: true }).count(), 0);
    };

    await scenario('the Contract row of the Run tests widget is red with the summed invalid responses and opens the first error story', async (page) => {
      await openWithErrorAndWarning(page);
      await expandTestingModule(page);
      // One invalid response of the error story and one of the warning story.
      const button = widgetContractButton(page, 'Mokapi: Error (2 invalid responses)');
      await button.waitFor({ timeout: 3000 });
      await showsText(button, '2');
      await button.hover();
      await page.getByText('Contract validation failed', { exact: true }).waitFor({ timeout: 3000 });
      await button.click();
      await page.getByRole('tab', { name: /^Mokapi/, selected: true }).waitFor();
      await eventually(async () => assert.match(page.url(), /path=\/story\/profile--error-invalid/));
    });

    await scenario('Clear all statuses turns the red Contract row of the Run tests widget gray', async (page) => {
      await openWithErrorAndWarning(page);
      await expandTestingModule(page);
      await widgetContractButton(page, 'Mokapi: Error (2 invalid responses)').waitFor({ timeout: 3000 });

      await clearAllStatusesButton(page).click();
      const button = widgetContractButton(page, 'Mokapi: No result');
      await button.waitFor({ timeout: 3000 });
      assert.equal(await button.isDisabled(), true);
    });

    // What addon-vitest's manager publishes when a run is over (`CurrentRun`), reduced to what the addon reads.
    // A real run can't be started from here, so the scenario emits the event itself.
    const runEntry = (status, errors) => ({
      sequence: 1,
      time: Date.now(),
      method: 'GET',
      url: '/api/profile',
      statusCode: 200,
      status,
      errors,
      operation: { api: 'Profile API', method: 'GET', path: '/api/profile' },
      operationUrl: dashboardOperationUrl(dashboard, 'Profile%20API/api/profile/get'),
      request: { headers: {}, body: '', truncated: false },
      response: { headers: { 'content-type': 'application/json' }, body: '{"name":"Jane Doe"}', truncated: false },
    });
    const mokapiRunReport = (status, entries) =>
      [{ type: 'mokapi', version: 1, status, result: { entries, notices: [], testMode: 'warning' } }];
    const componentTestStatus = (storyId, value, description = '') =>
      ({ storyId, typeId: 'storybook/component-test', value, title: 'Component tests', description });
    // A complete CurrentRun of addon-vitest: Storybook's own listeners on this
    // channel read e.g. `payload.config.a11y`.
    const completedRun = (reports, componentTestStatuses) => ({
      type: 'test-run-completed',
      payload: {
        triggeredBy: 'run-all',
        config: { coverage: false, a11y: false },
        a11yStatuses: [],
        componentTestCount: { success: 2, error: 1 },
        a11yCount: { success: 0, warning: 0, error: 0 },
        a11yReports: {},
        totalTestCount: 3,
        storyIds: undefined,
        startedAt: 0,
        finishedAt: 1,
        unhandledErrors: [],
        coverageSummary: undefined,
        reports,
        componentTestStatuses,
      },
    });
    const testRunEvent = (warned = 'profile--warning-invalid') => completedRun(
      { [warned]: mokapiRunReport('warning', [runEntry('invalid', [{ location: 'response.body', message: 'required properties are missing: email' }])]) },
      [
        componentTestStatus(warned, 'status-value:success'),
        // A failed story has no report: the run only knows the error text.
        componentTestStatus(
          'profile--error-invalid',
          'status-value:error',
          'Mokapi contract validation failed: 1 response does not match the contract.\n\nGET /api/profile\n    at <anonymous> (story.tsx:1:1)',
        ),
        componentTestStatus('profile--error-mixed', 'status-value:success'),
      ],
    );
    // A passed report with a valid response, a skipped one (passed without a valid response) and a story that ran
    // without a Mokapi report.
    const passedTestRunEvent = (passed, skipped, withoutReport) => completedRun(
      { [passed]: mokapiRunReport('passed', [runEntry('valid', [])]), [skipped]: mokapiRunReport('passed', []) },
      [passed, skipped, withoutReport].map((id) => componentTestStatus(id, 'status-value:success')),
    );
    const emitTestRunEvent = (page, event) => page.evaluate(
      (event) => window.__STORYBOOK_ADDONS_CHANNEL__.emit('storybook/test/channel', event),
      event,
    );
    const emitTestRun = (page, warned) => emitTestRunEvent(page, testRunEvent(warned));
    const testRunNote = (page) => page.getByTestId('mokapi-test-run-note');

    await scenario('after a test run the stories of the run get Mokapi statuses and the panel shows the run result', async (page) => {
      const [warned, failed, passedInRun, outsideRun] = ['profile--warning-invalid', 'profile--error-invalid', 'profile--error-mixed', 'profile--invalid'];
      await openStory(page, validatingStorybook.url, { id: 'profile--error-valid' });
      await finishedStory(page);
      await clearAllStatusesButton(page).click({ timeout: 2000 }).catch(() => {});
      await assertNoSidebarStatus(page, warned);
      await assertNoSidebarStatus(page, failed);

      // Two stories get a status from the Storybook UI before the run.
      await page.locator(`[id="${passedInRun}"]`).click();
      await assertSidebarStatus(page, passedInRun, 'Error');
      await page.locator(`[id="${outsideRun}"]`).click();
      await assertSidebarStatus(page, outsideRun, 'Warning');

      await emitTestRun(page);
      await assertSidebarStatus(page, warned, 'Warning');
      await assertSidebarStatus(page, failed, 'Error');
      await assertNoSidebarStatus(page, passedInRun);
      await assertSidebarStatus(page, outsideRun, 'Warning');

      assert.equal(await page.getByRole('tab', { name: /^Mokapi/, selected: true }).count(), 0);
      await sidebarRow(page, warned).hover();
      await sidebarRow(page, warned).getByRole('button', { name: 'Open context menu' }).click();
      await page.getByRole('button', { name: 'Mokapi: Warning' }).click();
      await page.getByRole('tab', { name: /^Mokapi/, selected: true }).waitFor();
    });

    await scenario('after a test run a passed story with a valid response gets the success status, a skipped story and a story without report lose theirs', async (page) => {
      const [passed, skipped, withoutReport] = ['profile--warning-invalid', 'profile--error-invalid', 'profile--error-mixed'];
      await openStory(page, validatingStorybook.url, { id: 'profile--error-valid' });
      await finishedStory(page);
      await clearAllStatusesButton(page).click({ timeout: 2000 }).catch(() => {});
      await assertNoSidebarStatus(page, passed);

      // The three stories get a status from the Storybook UI before the run.
      await page.locator(`[id="${passed}"]`).click();
      await assertSidebarStatus(page, passed, 'Warning');
      await page.locator(`[id="${skipped}"]`).click();
      await assertSidebarStatus(page, skipped, 'Error');
      await page.locator(`[id="${withoutReport}"]`).click();
      await assertSidebarStatus(page, withoutReport, 'Error');

      await emitTestRunEvent(page, passedTestRunEvent(passed, skipped, withoutReport));
      await assertSidebarStatus(page, passed, 'Success');
      await assertNoSidebarStatus(page, skipped);
      await assertNoSidebarStatus(page, withoutReport);
    });

    await scenario('the panel shows the passed result of the last test run, a skipped result is not shown', async (page) => {
      const [passed, skipped] = ['profile--valid', 'profile--off-invalid'];
      await page.goto(`${validatingStorybook.url}/?path=/story/${passed}&globals=mokapiValidation:off`);
      await toggleButton(page, 'off').waitFor();
      await waitForFinishedRender(page);
      await openMokapiPanel(page);
      await page.getByText(/Turn on validation/).waitFor();

      await emitTestRunEvent(page, passedTestRunEvent(passed, skipped, 'profile--error-mixed'));
      await showsText(testRunNote(page), 'Result of the last test run.');
      await showsText(reportBadge(page), 'PASS');
      await entries(page, 'valid').waitFor();

      // The skipped story has no result of the run: the panel shows what the UI knows, i.e. nothing.
      await page.locator(`[id="${skipped}"]`).click();
      await page.getByText(/Turn on validation/).waitFor();
      assert.equal(await testRunNote(page).count(), 0);
    });

    await scenario('the disable hint wins over the result of a test run for the disabled story', async (page) => {
      const disabled = 'profile--error-disabled';
      await openValidated(page, disabled);
      await assertOnlyDisabledHint(page);
      await emitTestRun(page, disabled);
      // The run result is in the manager once the sidebar shows its status; the hint stays.
      await assertSidebarStatus(page, disabled, 'Warning');
      await assertOnlyDisabledHint(page);
      assert.equal(await testRunNote(page).count(), 0);
    });

    await scenario('the panel shows the result of the last test run with validation off, a newer result replaces it', async (page) => {
      const [warned, failed] = ['profile--warning-invalid', 'profile--error-invalid'];
      // The manager forgets the run results with the page, so every step emits the event itself.
      await page.goto(`${validatingStorybook.url}/?path=/story/${warned}&globals=mokapiValidation:off`);
      await toggleButton(page, 'off').waitFor();
      await waitForFinishedRender(page);
      await openMokapiPanel(page);
      await page.getByText(/Turn on validation/).waitFor();

      await emitTestRun(page);
      await showsText(testRunNote(page), 'Result of the last test run.');
      await showsText(reportBadge(page), 'WARN');
      await showsText(reportHeadline(page), '1 response does not match the contract.');
      await entries(page, 'invalid').waitFor();
      assert.equal(await page.getByText(/Turn on validation/).count(), 0);

      // A failed story has no entries in the run, only the error text.
      await page.locator(`[id="${failed}"]`).click();
      await showsText(testRunNote(page), 'Result of the last test run.');
      await showsText(reportBadge(page), 'FAIL');
      await showsText(reportHeadline(page), '1 response does not match the contract.');
      assert.equal(await entries(page).count(), 0);

      await page.locator(`[id="${warned}"]`).click();
      await showsText(testRunNote(page), 'Result of the last test run.');
      await waitForFinishedRender(page);
      await switchValidationAndWait(page, 'on');
      await entries(page, 'invalid').waitFor();
      await showsText(reportBadge(page), 'WARN');
      assert.equal(await testRunNote(page).count(), 0);

      await waitForFinishedRender(page);
      await switchValidationAndWait(page, 'off');
      await page.getByText(/Turn on validation/).waitFor();
      assert.equal(await testRunNote(page).count(), 0);

      await emitTestRun(page);
      await showsText(testRunNote(page), 'Result of the last test run.');
      await assertSidebarStatus(page, warned, 'Warning');
      await clearAllStatusesButton(page).click();
      await assertNoSidebarStatus(page, warned);
      await assertNoSidebarStatus(page, failed);
      await page.getByText(/Turn on validation/).waitFor();
      assert.equal(await testRunNote(page).count(), 0);
    });

    await scenario('a test run that arrives before the report of the story that is still mounting keeps its result in the panel and the sidebar', async (page) => {
      const held = 'profile--warning-held';
      await openStory(page, validatingStorybook.url, { id: 'profile--error-valid' });
      await finishedStory(page);
      await clearAllStatusesButton(page).click({ timeout: 2000 }).catch(() => {});
      await assertNoSidebarStatus(page, held);
      await openMokapiPanel(page);

      // The addon's own listeners are registered earlier, so when these promises resolve, the manager has handled the action.
      await page.evaluate((storyId) => {
        const waitFor = (type) => new Promise((resolve) => {
          window.__STORYBOOK_ADDONS_CHANNEL__.on('mokapi/validation', (action) => {
            if (action.type === type && action.storyId === storyId) resolve();
          });
        });
        window.__mountStarted = waitFor('render-started');
        window.__mountReported = waitFor('report');
      }, held);

      // The held response keeps the mount from reporting. Once the request is waiting, the mount has announced
      // itself, so the run below is newer than the mount and the mount's report is older than the run.
      await page.locator(`[id="${held}"]`).click();
      await page.evaluate(() => window.__mountStarted);
      await page.frame({ name: 'storybook-preview-iframe' }).waitForFunction(() => typeof window.__releaseProfile === 'function');
      await emitTestRun(page, held);
      await showsText(testRunNote(page), 'Result of the last test run.');
      await assertSidebarStatus(page, held, 'Warning');

      await page.frame({ name: 'storybook-preview-iframe' }).evaluate(() => window.__releaseProfile());
      await page.evaluate(() => window.__mountReported);
      // The mount's valid report is older than the run: the run result stays, the report does not unset the status.
      await assertCountStays(testRunNote(page), 1);
      await showsText(reportBadge(page), 'WARN');
      await assertSidebarStatus(page, held, 'Warning');
    });

    await scenario('a story that is mounted again without a request keeps its warning in the panel and the sidebar', async (page) => {
      const cached = 'profile--warning-cached';
      await openValidated(page, cached);
      await showsText(reportBadge(page), 'WARN');
      await entries(page, 'invalid').waitFor();
      await assertSidebarStatus(page, cached, 'Warning');

      // The second mount is answered from the story's cache: no request, so the mount validates nothing.
      await page.locator('[id="profile--valid"]').click();
      await showsText(reportBadge(page), 'PASS');
      await page.locator(`[id="${cached}"]`).click();
      await profileInPreview(page).getByText('Jane Doe').waitFor();
      await waitForFinishedRender(page);
      await assertCountStays(reportBadge(page), 1);
      await showsText(reportBadge(page), 'WARN');
      await entries(page, 'invalid').waitFor();
      await assertSidebarStatus(page, cached, 'Warning');
    });

    // Editing a story to `disable: true` or `test: 'off'` mounts it again with the new configuration (HMR). The story
    // `Reconfigurable` reads its configuration from the URL of the preview, so the scenarios reload only the preview
    // iframe: the manager keeps its state, as it does with HMR, and the mount is the only thing that changes.
    const reconfigurable = 'profile--reconfigurable';
    const reloadPreviewWith = async (page, configuration, validation) => {
      await page.frame({ name: 'storybook-preview-iframe' })
        .goto(`${validatingStorybook.url}/iframe.html?id=${reconfigurable}&viewMode=story&globals=mokapiValidation:${validation}&mokapi=${configuration}`);
      await waitForFinishedRender(page);
      // The handler answers only if MSW started again in the new document.
      await profileInPreview(page).getByText('Jane Doe').waitFor();
    };
    const earlierResults = {
      'UI result': async () => {},
      'test run': async (page) => {
        await emitTestRunEvent(page, completedRun(
          { [reconfigurable]: mokapiRunReport('warning', [runEntry('invalid', [{ location: 'response.body', message: 'required properties are missing: email' }])]) },
          [componentTestStatus(reconfigurable, 'status-value:success')],
        ));
        await showsText(testRunNote(page), 'Result of the last test run.');
      },
    };

    for (const source of Object.keys(earlierResults)) {
      for (const configuration of ['disable', 'off']) {
        for (const validation of ['on', 'off']) {
          await scenario(`a story with an earlier ${source} has no Mokapi result once it is mounted with ${configuration} and validation ${validation}`, async (page) => {
            await openWithClearedStatuses(page, reconfigurable);
            await showsText(reportBadge(page), 'WARN');
            await assertSidebarStatus(page, reconfigurable, 'Warning');
            await earlierResults[source](page);
            if (validation === 'off') {
              // Switching the toggle clears nothing.
              await waitForFinishedRender(page);
              await switchValidationAndWait(page, 'off');
              await assertSidebarStatus(page, reconfigurable, 'Warning');
            }

            await reloadPreviewWith(page, configuration, validation);

            await assertNoSidebarStatus(page, reconfigurable);
            await expandTestingModule(page);
            const widgetRow = widgetContractButton(page, 'Mokapi: No result');
            await widgetRow.waitFor({ timeout: 3000 });
            assert.equal(await widgetRow.isDisabled(), true);
            const menuRow = await contractRowOf(page, reconfigurable, 'Mokapi: No result');
            await menuRow.waitFor({ timeout: 3000 });
            assert.equal(await menuRow.isDisabled(), true);
            assert.equal(await testRunNote(page).count(), 0);
            if (configuration === 'disable') {
              await assertOnlyDisabledHint(page);
            } else if (validation === 'on') {
              await showsText(testModeOffText(page), TEST_MODE_TEXTS.off);
              await entries(page, 'invalid').waitFor();
              assert.equal(await reportBadge(page).count(), 0);
            } else {
              await page.getByText(/Turn on validation/).waitFor();
              assert.equal(await reportBadge(page).count(), 0);
            }
          });
        }
      }
    }

    await scenario('with test error a response that does not match the contract fails the story', async (page) => {
      await openValidated(page, 'profile--error-invalid');
      await assertStoryFails(page, /^1 response does not match the contract\.$/);
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
      await assertStoryFails(page, /1 response does not match the contract\./);
    });

    // The handler never answers, so nothing is validated: the story is skipped, not a contract failure.
    const handlerTimeout = (seconds) => `No response from the MSW handler within ${seconds} s (GET /api/profile), not validated. If the response is delayed on purpose, increase parameters.mokapi.timeout or defaultTimeout.`;
    // theme.color.warning of the light theme
    const WARNING_COLOR = 'rgb(230, 157, 0)';

    for (const [id, seconds] of [['profile--error-never-answers', 4], ['profile--error-short-timeout', 1.5]]) {
      await scenario(`with test error a response that never comes is skipped after ${seconds} s with a notice that names the handler`, async (page) => {
        await openValidated(page, id);
        await showsText(reportBadge(page), 'WAIT');
        await showsText(reportBadge(page), 'SKIP');
        await showsText(reportHeadline(page), handlerTimeout(seconds));
        const handlerNotice = notice(page, handlerTimeout(seconds));
        await handlerNotice.waitFor();
        assert.equal(await colorOf(handlerNotice), WARNING_COLOR);
        const finished = await assertStoryStaysGreen(page);
        assert.deepEqual(mokapiReports(finished).map(({ status }) => status), ['passed']);
        await assertNoSidebarStatus(page, id);
      });
    }

    await scenario('with test error a handler that is slower than the default limit but within `timeout` is validated', async (page) => {
      await openValidated(page, 'profile--error-slow-handler');
      await assertStoryFails(page, /^1 response does not match the contract\.$/);
      assert.equal(await notice(page, /did not finish|No response from the MSW handler/).count(), 0);
    });

    await scenario('with test error a response MSW delivered but Mokapi did not judge in time fails the story with a timeout notice', async (page, context) => {
      // Mokapi's answer never comes: the route is neither fulfilled nor continued.
      await context.route(`${dashboard}${VALIDATE_PATH}`, () => {});
      await openValidated(page, 'profile--error-mokapi-too-slow');
      const message = 'Mokapi validation did not finish within 1.5 s (GET /api/profile). Increase parameters.mokapi.timeout or defaultTimeout.';
      await assertStoryFails(page, new RegExp(escapeRegExp(message)));
      const failingNotice = notice(page, message);
      await failingNotice.waitFor();
      assert.equal(await colorOf(failingNotice), 'rgb(255, 68, 0)');
    });

    await scenario('an invalid timeout parameter shows a configuration notice and the story uses the default limit', async (page) => {
      await openValidated(page, 'profile--invalid-timeout-parameter');
      await notice(page, 'Mokapi: parameters.mokapi.timeout must be a positive number.').waitFor();
      await showsText(reportBadge(page), 'WARN');
      await entries(page, 'valid').waitFor();
    });

    for (const id of ['profile--error-valid', 'profile--error-no-worker', 'profile--error-no-request', 'profile--error-bypass', 'profile--error-handler-throws']) {
      await scenario(`with test error the story ${id} does not fail`, async (page) => {
        await openValidated(page, id);
        await assertStoryStaysGreen(page);
      });
    }

    // The stand-in addons throw when the Mokapi report exists at their afterEach, so a green story means they ran first.
    await scenario('the Mokapi afterEach runs after the afterEach of addons listed before and after it', async (page) => {
      await openValidated(page, 'profile--after-each-order');
      await entries(page, 'valid').waitFor();
      const finished = await assertStoryStaysGreen(page);
      assert.equal(mokapiReports(finished).length, 1);
    });

    await scenario('with test error a disabled story and validation off never fail', async (page) => {
      await openValidated(page, 'profile--error-disabled');
      const disabled = await assertStoryStaysGreen(page);
      assert.deepEqual(mokapiReports(disabled), []);

      await openStory(page, storybook.url, { id: 'profile--error-invalid' });
      assert.deepEqual(mokapiReports(await assertStoryStaysGreen(page)), []);
    });

    await scenario('with test warning the contract error stays green and is reported as a warning', async (page) => {
      await openValidated(page, 'profile--warning-invalid');
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
      await assertStoryFails(page, /1 response does not match the contract\./);
      assert.equal(await entries(page, 'invalid').count(), 1);
    });

    await scenario('a re-render after another global changed keeps the invalid result and the failing story', async (page) => {
      // `theme` is a second global of the fixture that no story uses. Changing it re-renders the story without remounting it.
      await page.goto(`${storybook.url}/?path=/story/profile--error-invalid&globals=mokapiValidation:on;theme:light`);
      await toggleButton(page, 'on').waitFor();
      await openMokapiPanel(page);
      await assertStoryFails(page, /1 response does not match the contract\./);
      await entries(page, 'invalid').waitFor();

      const preview = page.frame({ name: 'storybook-preview-iframe' });
      const finished = await preview.evaluate(() => window.__storyFinished.length);
      await page.evaluate(() => window.__STORYBOOK_ADDONS_CHANNEL__.emit('updateGlobals', { globals: { theme: 'dark' } }));
      await preview.waitForFunction((count) => window.__storyFinished.length > count, finished);

      await assertStoryFails(page, /1 response does not match the contract\./);
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
      const storyNames = ['ErrorInvalid', 'ErrorNeverAnswers', 'ErrorValid', 'WarningInvalid', 'OffInvalid', 'AfterEachOrder'];
      const story = await runStoriesWithVitest(
        { MOKAPI_DASHBOARD: dashboard, MOKAPI_DEFAULT_VALIDATION: 'true' },
        join(directory, 'vitest.json'),
        storyNames,
      );
      const failures = (name) => story(name).failureMessages.join('\n');
      story('ErrorInvalid').expect('failed');
      assert.match(failures('ErrorInvalid'), /MokapiContractError: Mokapi contract validation failed: 1 response does not match the contract\./);
      // A response that never comes is skipped. Vitest's own timeout would say "Test timed out", so this also shows
      // that the addon's limit (4 s) fits into the default.
      for (const name of ['ErrorNeverAnswers', 'ErrorValid', 'WarningInvalid', 'OffInvalid', 'AfterEachOrder']) story(name).expect('passed');
    });

    await scenario('defaultTest error fails a story without its own test parameter', async (page) => {
      await openValidated(page, 'profile--invalid', failingStorybook);
      await assertStoryFails(page, /1 response does not match the contract\./);
      await reportBadge(page).waitFor();
      await assertBadgeTooltip(reportBadge(page), TEST_MODE_TEXTS.error);
    });
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    if (failureDirectory) console.error(`E2E failure artifacts kept in ${failureDirectory}`);
    // Every teardown step runs, even when an earlier one fails. The directory goes last, because Mokapi runs in it.
    const stops = await Promise.allSettled([
      browser?.close(),
      ...storybooks.map((storybook) => storybook.stop()),
      stopMokapi?.(),
    ]);
    const teardownErrors = stops.filter(({ status }) => status === 'rejected').map(({ reason }) => reason);
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      teardownErrors.push(error);
    }
    // A throw in `finally` replaces the error of the test, so a failed test only logs the teardown errors.
    if (testFailed) {
      teardownErrors.forEach((error) => console.error('E2E teardown failed:', error));
    } else if (teardownErrors.length > 0) {
      // node:test prints only message and stack of an error, so the messages of the members go into the message.
      // eslint-disable-next-line no-unsafe-finally -- testFailed is false here, so no error of the test is replaced
      throw new AggregateError(teardownErrors,
        `E2E teardown failed: ${teardownErrors.map((error) => error.message).join('; ')}`);
    }
  }
});
