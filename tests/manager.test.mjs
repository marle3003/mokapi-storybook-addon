import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The manager bundle only runs inside Storybook's manager. These tests load it with fakes for the manager modules:
// `addons.register` hands over a fake `api` that records its channel handlers, `experimental_getStatusStore` is a
// recording store. Everything that only draws (components, theming, icons) is a callable proxy, because the bundle
// calls it while it loads. Then the handlers that tie channel events to the sidebar status can be driven directly.
const STORYBOOK_IMPORT = /^import (?:\{([^}]+)\}) from '(?:storybook\/[^']+|@storybook\/icons)';$/gm;
const EVENTS = ['FORCE_REMOUNT', 'GLOBALS_UPDATED', 'SET_GLOBALS', 'STORY_CHANGED', 'STORY_RENDER_PHASE_CHANGED'];

const distUrl = (file) => new URL(`../dist/${file}`, import.meta.url).href;

function drawingFake() {
  const fake = new Proxy(function () {}, { get: (_, property) => (property === 'then' ? undefined : fake), apply: () => fake });
  return fake;
}

// One fresh manager per test: its module-level state (test runs, mounts, panel) starts empty.
async function loadManager() {
  const handlers = new Map();
  const statuses = new Map();
  const statusStore = {
    set: (list) => list.forEach((status) => statuses.set(status.storyId, status)),
    unset: (storyIds) => (storyIds === undefined ? statuses.clear() : storyIds.forEach((storyId) => statuses.delete(storyId))),
    getAll: () => ({}),
    onSelect: () => {},
  };
  const emitted = [];
  const url = { viewMode: 'story', storyId: undefined };
  const api = {
    on: (event, handler) => handlers.set(event, handler),
    emit: (event, payload) => emitted.push({ event, payload }),
    getGlobals: () => ({ mokapiValidation: 'on' }),
    getUrlState: () => url,
    getCurrentStoryData: () => ({ id: url.storyId }),
  };
  const fakes = new Proxy({
    addons: { register: (_, callback) => callback(api), add: () => {} },
    experimental_getStatusStore: () => statusStore,
    types: { TOOL: 'tool', PANEL: 'panel', experimental_TEST_PROVIDER: 'test-provider' },
    ...Object.fromEntries(EVENTS.map((name) => [name, name])),
  }, { get: (target, name) => (name in target ? target[name] : drawingFake()) });

  const directory = await mkdtemp(join(tmpdir(), 'mokapi-manager-'));
  try {
    await writeFile(join(directory, 'fakes.mjs'), 'export let fakes;\nexport const install = (value) => { fakes = value; };\n');
    const fakesModule = await import(pathToFileURL(join(directory, 'fakes.mjs')).href);
    fakesModule.install(fakes);
    const source = (await readFile(new URL('../dist/manager.js', import.meta.url), 'utf8'))
      .replace(STORYBOOK_IMPORT, (_, names) => `const { ${names} } = (await import('${pathToFileURL(join(directory, 'fakes.mjs')).href}')).fakes;`)
      .replace(/from '\.\/([^']+)'/g, (_, file) => `from '${distUrl(file)}'`)
      .replace("from 'react'", `from '${import.meta.resolve('react')}'`);
    await writeFile(join(directory, 'manager.mjs'), source);
    await import(pathToFileURL(join(directory, 'manager.mjs')).href);
  } finally {
    await rm(directory, { recursive: true });
  }
  return {
    emitPanel: (action) => handlers.get('mokapi/validation')(action),
    emitTestRun: (event) => handlers.get('storybook/test/channel')(event),
    sidebarStatus: (storyId) => statuses.get(storyId)?.value,
    emitChannel: (event, payload) => handlers.get(event)(payload),
    select: (storyId) => { url.storyId = storyId; },
    remounts: () => emitted.filter(({ event }) => event === 'FORCE_REMOUNT').map(({ payload }) => payload),
  };
}

const STORY = 'profile--warning-invalid';
const mokapiReport = (status, entries) => ({ type: 'mokapi', version: 1, status, result: { entries, notices: [], testMode: 'warning' } });
const invalidEntry = { sequence: 1, time: 0, method: 'GET', url: '/api/profile', statusCode: 200, status: 'invalid', errors: [{ location: 'response.body', message: 'required properties are missing: email' }] };

// What addon-vitest's manager publishes when a run is over (`CurrentRun`), reduced to what the addon reads.
const warningRun = () => ({
  type: 'test-run-completed',
  payload: {
    reports: { [STORY]: [mokapiReport('warning', [invalidEntry])] },
    componentTestStatuses: [{ storyId: STORY, typeId: 'storybook/component-test', value: 'status-value:success', title: 'Component tests', description: '' }],
  },
});

// A mount that validated nothing: the story requested nothing (e.g. the app answers from its cache).
const startSkippedMount = (manager, renderId) => {
  manager.emitPanel({ type: 'render-started', storyId: STORY, renderId, testMode: 'warning' });
  manager.emitPanel({ type: 'report', renderId, storyId: STORY, status: 'passed', headline: '', invalid: 0, valid: 0 });
};

test('a story mounted again without a validated response keeps the warning of its last UI result in the sidebar', async () => {
  const manager = await loadManager();
  manager.emitPanel({ type: 'render-started', storyId: STORY, renderId: 1, testMode: 'warning' });
  manager.emitPanel({ type: 'report', renderId: 1, storyId: STORY, status: 'warning', headline: '1 response does not match the contract.', invalid: 1, valid: 0 });
  assert.equal(manager.sidebarStatus(STORY), 'status-value:warning');

  startSkippedMount(manager, 2);

  assert.equal(manager.sidebarStatus(STORY), 'status-value:warning');
});

test('a story mounted again without a validated response keeps the warning of the last test run in the sidebar', async () => {
  const manager = await loadManager();
  manager.emitTestRun(warningRun());
  assert.equal(manager.sidebarStatus(STORY), 'status-value:warning');

  startSkippedMount(manager, 1);

  assert.equal(manager.sidebarStatus(STORY), 'status-value:warning');
});

test('a mount that validated a response after a warning clears the warning in the sidebar', async () => {
  const manager = await loadManager();
  manager.emitTestRun(warningRun());
  manager.emitPanel({ type: 'render-started', storyId: STORY, renderId: 1, testMode: 'warning' });
  manager.emitPanel({ type: 'report', renderId: 1, storyId: STORY, status: 'passed', headline: '', invalid: 0, valid: 1 });

  assert.equal(manager.sidebarStatus(STORY), 'status-value:success');
});

test('a first mount without a validated response sets no status', async () => {
  const manager = await loadManager();

  startSkippedMount(manager, 1);

  assert.equal(manager.sidebarStatus(STORY), undefined);
});

// The manager was reloaded while the preview kept running: the report comes without the render-started of its mount.
test('a report without a render-started of its story still sets the sidebar status', async () => {
  const manager = await loadManager();

  manager.emitPanel({ type: 'report', renderId: 1, storyId: STORY, status: 'warning', headline: '1 response does not match the contract.', invalid: 1, valid: 0 });

  assert.equal(manager.sidebarStatus(STORY), 'status-value:warning');
});

// Switches validation on while `a--one` is selected and lets its re-render finish after `afterSwitch` ran.
async function switchValidationOn(afterSwitch) {
  const manager = await loadManager();
  manager.select('a--one');
  manager.emitChannel('SET_GLOBALS', { globals: { mokapiValidation: 'off' } });
  manager.emitChannel('GLOBALS_UPDATED', { globals: { mokapiValidation: 'on' } });
  manager.emitChannel('STORY_RENDER_PHASE_CHANGED', { newPhase: 'loading', storyId: 'a--one' });
  afterSwitch(manager);
  manager.emitChannel('STORY_RENDER_PHASE_CHANGED', { newPhase: 'finished', storyId: 'a--one' });
  return manager;
}

test('a switch remounts the story once its re-render has finished while it is still selected', async () => {
  const manager = await switchValidationOn(() => {});

  assert.deepEqual(manager.remounts(), [{ storyId: 'a--one' }]);
});

// The click selects the next story before STORY_CHANGED reaches the manager.
test('a switch does not remount the story when another story was selected before its re-render finished', async () => {
  const manager = await switchValidationOn((m) => m.select('a--two'));

  assert.deepEqual(manager.remounts(), []);
});

// A mount of a disabled story or of a story in test mode 'off': the preview marks it `unjudged`.
const startUnjudgedMount = (manager, renderId, storyId = STORY, testMode) =>
  manager.emitPanel({ type: 'render-started', storyId, renderId, unjudged: true, ...(testMode && { testMode }) });

const warnFromUi = (manager, renderId, storyId = STORY) => {
  manager.emitPanel({ type: 'render-started', storyId, renderId, testMode: 'warning' });
  manager.emitPanel({ type: 'report', renderId, storyId, status: 'warning', headline: '1 response does not match the contract.', invalid: 1, valid: 0 });
};

test('an unjudged mount removes the sidebar status of a warning from the UI', async () => {
  const manager = await loadManager();
  warnFromUi(manager, 1);
  assert.equal(manager.sidebarStatus(STORY), 'status-value:warning');

  startUnjudgedMount(manager, 2);

  assert.equal(manager.sidebarStatus(STORY), undefined);
});

test('an unjudged mount removes the sidebar status of a warning from a test run', async () => {
  const manager = await loadManager();
  manager.emitTestRun(warningRun());
  assert.equal(manager.sidebarStatus(STORY), 'status-value:warning');

  startUnjudgedMount(manager, 1, STORY, 'off');

  assert.equal(manager.sidebarStatus(STORY), undefined);
});

test('an unjudged mount leaves the sidebar status of another story', async () => {
  const manager = await loadManager();
  warnFromUi(manager, 1, 'a--one');
  warnFromUi(manager, 2, 'a--two');

  startUnjudgedMount(manager, 3, 'a--one');

  assert.equal(manager.sidebarStatus('a--one'), undefined);
  assert.equal(manager.sidebarStatus('a--two'), 'status-value:warning');
});

test('a story judged after an unjudged mount gets its status again', async () => {
  const manager = await loadManager();
  warnFromUi(manager, 1);
  startUnjudgedMount(manager, 2, STORY, 'off');

  warnFromUi(manager, 3);

  assert.equal(manager.sidebarStatus(STORY), 'status-value:warning');
});

test('a report of an ordinary story still sets its status next to an unjudged one', async () => {
  const manager = await loadManager();
  startUnjudgedMount(manager, 1, 'a--one');

  warnFromUi(manager, 2, 'a--two');

  assert.equal(manager.sidebarStatus('a--one'), undefined);
  assert.equal(manager.sidebarStatus('a--two'), 'status-value:warning');
});

test('a test run after an unjudged mount leaves the story without status', async () => {
  const manager = await loadManager();
  warnFromUi(manager, 1);
  startUnjudgedMount(manager, 2, STORY, 'off');

  manager.emitTestRun({
    type: 'test-run-completed',
    payload: { reports: {}, componentTestStatuses: [{ storyId: STORY, typeId: 'storybook/component-test', value: 'status-value:success', title: 'Component tests', description: '' }] },
  });

  assert.equal(manager.sidebarStatus(STORY), undefined);
});
