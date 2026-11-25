// Takes the images of the addon (README, docs on mokapi.io) from the showcase in showcase/.
// Needs a fresh `npm run build`.
//   npm run screenshot                                  all shots, light theme
//   npm run screenshot -- --only partial                shots whose name or file contains the text
//   npm run screenshot -- --theme dark
//   npm run screenshot -- --docs-dir ../mokapi/docs/integrations/storybook
// Without --docs-dir the docs shots go to screenshots/ (git-ignored).
// MOKAPI_BIN overrides the go-mokapi binary, e.g. for a local Mokapi build.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { mokapiBinary, stopProcess, unusedPorts } from './processes.mjs';
import { clipBelowContent, outputFiles, parseOptions, selectShots } from './screenshot-options.mjs';
import { shots } from './shots.mjs';

const require = createRequire(import.meta.url);
const repositoryFile = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const showcaseDirectory = repositoryFile('showcase/');
const folders = { outDir: repositoryFile('screenshots'), readmeDir: repositoryFile('docs') };

// The time in the panel entries is the same in every run.
const FIXED_TIME = new Date('2026-01-15T10:30:00Z');
const SHOT_TIMEOUT_MS = 30000;
const STARTUP_TIMEOUT_MS = 120000;
const PANEL_SELECTOR = '#storybook-panel-root';
const SIDEBAR_SELECTOR = '.sidebar-container';

const settledBadge = (page) => page.getByTestId('mokapi-report-badge').filter({ hasText: /^(PASS|WARN|FAIL|PARTIAL)$/ });

async function waitUntil(isReady, what, hasExited = () => false) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (true) {
    try {
      if (await isReady()) return;
    } catch { /* not ready yet */ }
    if (hasExited()) throw new Error(`${what} exited before it was ready`);
    if (Date.now() >= deadline) throw new Error(`${what} did not start within ${STARTUP_TIMEOUT_MS / 1000} s`);
    await setTimeout(500);
  }
}

// Spawns a child and returns it with a promise that settles when it is gone.
function spawnChild(command, args, options) {
  const child = spawn(command, args, options);
  // A failed spawn (e.g. a wrong MOKAPI_BIN) leaves exitCode null, so it counts as exited here.
  let spawnFailed = false;
  child.once('error', () => { spawnFailed = true; });
  const stopped = new Promise((done) => {
    child.once('error', done);
    child.once('exit', done);
  });
  return { child, stopped, hasExited: () => spawnFailed || child.exitCode !== null };
}

// Mokapi takes the HTTP port from the servers URL of the contract.
async function startMokapi({ directory, apiPort, dashboardPort, onStop }) {
  const contract = JSON.parse(await readFile(join(showcaseDirectory, 'openapi.json'), 'utf8'));
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
  const env = { ...process.env };
  delete env.MOKAPI_BIN;
  const { child, stopped, hasExited } = spawnChild(mokapiBinary(), [], { cwd: directory, env, stdio: 'ignore' });
  onStop(() => stopProcess(stopped, (signal) => child.kill(signal)));
  const dashboard = `http://localhost:${dashboardPort}`;
  await waitUntil(async () => (await fetch(`${dashboard}/api/info`)).ok, 'Mokapi', hasExited);
  return dashboard;
}

// Storybook starts child processes, so it runs in its own process group and the group is stopped.
async function startStorybook({ port, dashboard, testMode, onStop }) {
  const cli = join(dirname(require.resolve('storybook/package.json')), 'dist/bin/dispatcher.js');
  const { child, stopped, hasExited } = spawnChild(process.execPath, [
    cli, 'dev', '--ci', '--port', String(port), '--exact-port', '--no-open', '--disable-telemetry',
    '--config-dir', join(showcaseDirectory, '.storybook'),
  ], {
    cwd: showcaseDirectory,
    env: {
      ...process.env,
      MOKAPI_DASHBOARD: dashboard,
      MOKAPI_DEFAULT_VALIDATION: 'true',
      MOKAPI_DEFAULT_TEST: testMode,
      STORYBOOK_DISABLE_TELEMETRY: '1',
    },
    detached: true,
    stdio: 'ignore',
  });
  const killGroup = (signal) => {
    try { process.kill(-child.pid, signal); } catch { /* the group is already gone */ }
  };
  onStop(() => stopProcess(stopped, killGroup));
  const url = `http://localhost:${port}`;
  await waitUntil(async () => (await fetch(`${url}/index.json`)).ok, `Storybook (test mode ${testMode})`, hasExited);
  return url;
}

// The first load makes Vite optimize dependencies and reload. It uses its own page: MSW's service
// worker unregisters when its last client closes, so a navigated warm-up page would stay unmocked.
async function warmUp(browser, storybook) {
  const page = await browser.newPage();
  await page.goto(`${storybook}/iframe.html?id=orders--valid&viewMode=story`);
  await page.locator('.shop-card').first().waitFor({ timeout: STARTUP_TIMEOUT_MS });
  await page.close();
}

async function openStory(page, id) {
  await page.locator(`[data-item-id="${id}"]`).click();
  await page.frame({ name: 'storybook-preview-iframe' }).waitForFunction(
    (storyId) => window.__STORYBOOK_PREVIEW__?.currentRender?.id === storyId
      && window.__STORYBOOK_PREVIEW__.currentRender.phase === 'finished',
    id,
    { timeout: SHOT_TIMEOUT_MS },
  );
  await settledBadge(page).waitFor({ timeout: SHOT_TIMEOUT_MS });
}

// The sidebar status exists only for rendered stories, so each story is opened and judged once.
// The shot's own story is selected again at the end, it is the one the image highlights.
async function visitAllStories(page, storybook, shotStory) {
  const index = await (await fetch(`${storybook}/index.json`)).json();
  for (const { id } of Object.values(index.entries).filter((entry) => entry.type === 'story')) {
    await openStory(page, id);
  }
  await openStory(page, shotStory);
}

async function waitForExpectedPanel(page, { badge, text, entries }) {
  if (badge) await page.getByTestId('mokapi-report-badge').filter({ hasText: new RegExp(`^${badge}$`) }).waitFor({ timeout: SHOT_TIMEOUT_MS });
  if (entries !== undefined) {
    await page.getByTestId('mokapi-entry').nth(entries - 1).waitFor({ timeout: SHOT_TIMEOUT_MS });
    const shown = await page.getByTestId('mokapi-entry').count();
    if (shown !== entries) throw new Error(`The panel shows ${shown} entries, expected ${entries}`);
  }
  if (text) await page.getByText(text).filter({ visible: true }).first().waitFor({ timeout: SHOT_TIMEOUT_MS });
}

// The region of the panel that has content: down to the last entry, or the toolbar (Rerun button) without entries.
async function panelClip(page) {
  const panel = await page.locator(PANEL_SELECTOR).boundingBox();
  const lastEntry = page.getByTestId('mokapi-entry').last();
  const lowest = await lastEntry.count() > 0 ? lastEntry : page.getByTestId('mokapi-rerun');
  const { y, height } = await lowest.boundingBox();
  return clipBelowContent(panel, y + height);
}

// Storybook's "What's new" notification would cover the sidebar.
async function dismissNotifications(page) {
  const dismiss = page.getByRole('button', { name: 'Dismiss notification' });
  while (await dismiss.count() > 0) await dismiss.first().click();
}

async function screenshotOf(page, clip) {
  if (clip === 'panel') return page.screenshot({ clip: await panelClip(page) });
  if (clip === 'sidebar') return page.locator(SIDEBAR_SELECTOR).screenshot();
  return page.screenshot();
}

async function takeShot(browser, shot, { storybook, options }) {
  const context = await browser.newContext({
    viewport: shot.viewport,
    deviceScaleFactor: shot.deviceScaleFactor,
    colorScheme: options.theme,
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(FIXED_TIME);
    const params = new URLSearchParams({ path: `/story/${shot.story}`, ...shot.params });
    await page.goto(`${storybook}/?${params}`);
    if (shot.visitAllStories) await visitAllStories(page, storybook, shot.story);
    await waitForExpectedPanel(page, shot.expect);
    await dismissNotifications(page);
    // Lets the layout settle after the notification is gone.
    await setTimeout(500);
    const image = await screenshotOf(page, shot.clip);
    const files = outputFiles(shot, { ...folders, docsDir: options.docsDir });
    for (const file of files) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, image);
    }
    return files;
  } finally {
    await context.close();
  }
}

// Takes the shots and reports every one. A failing shot is named and the others continue.
// Returns the number of failed shots.
async function takeShots(selected, { browser, storybooks, options }) {
  let failed = 0;
  for (const shot of selected) {
    try {
      const files = await takeShot(browser, shot, { storybook: storybooks[shot.testMode], options });
      console.log(`ok      ${shot.name}  ${files.join(', ')}`);
    } catch (error) {
      failed++;
      console.error(`FAILED  ${shot.name}\n${error instanceof Error ? error.message : error}`);
    }
  }
  return failed;
}

// Starts Mokapi, one Storybook per test mode and the browser, takes the shots and stops everything,
// also on SIGINT and SIGTERM. Returns the exit code.
async function run(selected, options) {
  const directory = await mkdtemp(join(tmpdir(), 'mokapi-storybook-screenshot-'));
  const stops = [];
  const stopAll = async () => {
    for (const stop of stops.reverse()) {
      try { await stop(); } catch { /* the other stops must still run */ }
    }
    await rm(directory, { recursive: true, force: true });
  };
  // Stays registered while the cleanup runs, so a second Ctrl-C doesn't kill Node and leave Storybook behind.
  let stopping;
  const onSignal = () => { stopping ??= stopAll().finally(() => process.exit(1)); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const onStop = (stop) => stops.push(stop);
  try {
    const testModes = [...new Set(selected.map((shot) => shot.testMode))];
    const [apiPort, dashboardPort, ...storybookPorts] = await unusedPorts(2 + testModes.length);
    const dashboard = await startMokapi({ directory, apiPort, dashboardPort, onStop });
    const storybooks = {};
    for (const [index, testMode] of testModes.entries()) {
      storybooks[testMode] = await startStorybook({ port: storybookPorts[index], dashboard, testMode, onStop });
    }
    const browser = await chromium.launch();
    onStop(() => browser.close());
    for (const storybook of Object.values(storybooks)) await warmUp(browser, storybook);
    const failed = await takeShots(selected, { browser, storybooks, options });
    return failed === 0 ? 0 : 1;
  } catch (error) {
    console.error(error);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await stopAll();
  }
}

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.docsDir) options.docsDir = resolve(options.docsDir);
  const selected = selectShots(shots, options.only);
  if (selected.length === 0) throw new Error(`No shot matches --only ${options.only}`);
  process.exitCode = await run(selected, options);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
