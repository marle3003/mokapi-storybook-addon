import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolveOptions } from '../dist/index.js';
import { initialPanelState, invalidCount, reducePanel, resultsOfStory } from '../dist/results.js';
import { previewAnnotations, managerEntries, managerHead, viteFinal } from '../dist/preset.js';
import { initialRemountState, nextRemount } from '../dist/remount.js';
import { validationHook } from '../dist/listener.js';
import { classify, sendValidation, serializePair } from '../dist/validation.js';

test('options default to the local Mokapi dashboard and validation off', () => {
  assert.deepEqual(resolveOptions(), { dashboardUrl: 'http://localhost:8080', defaultValidation: false });
  assert.deepEqual(resolveOptions({}), resolveOptions());
});

test('options keep the given values and strip trailing slashes from the dashboard URL', () => {
  assert.deepEqual(
    resolveOptions({ dashboardUrl: 'https://mokapi.example.com/', defaultValidation: true }),
    { dashboardUrl: 'https://mokapi.example.com', defaultValidation: true },
  );
});

test('options ignore settings that were removed from the addon', () => {
  assert.deepEqual(resolveOptions({ target: 'http://localhost:3000', proxyPath: '/mokapi' }), resolveOptions());
});

test('options reject a dashboard URL that is not HTTP(S) and a non-boolean defaultValidation', () => {
  assert.throws(() => resolveOptions({ dashboardUrl: 'ftp://localhost:8080' }), /Mokapi: dashboardUrl must be an HTTP\(S\) URL/);
  assert.throws(() => resolveOptions({ dashboardUrl: 'not a url' }), /Mokapi: dashboardUrl must be an HTTP\(S\) URL/);
  assert.throws(() => resolveOptions({ defaultValidation: 'yes' }), /Mokapi: defaultValidation must be true or false/);
});

const dashboardUrl = 'http://localhost:8080';

// Answers of Mokapi 0.58.0 (see mokapi/acceptance/http_validate_test.go).
const answers = {
  valid: { valid: true, operation: { api: 'Profile API', method: 'GET', path: '/profile' }, errors: [] },
  invalid: {
    valid: false,
    operation: { api: 'Profile API', method: 'GET', path: '/profile' },
    errors: [{ location: 'response.body', schema: '#/required', message: 'required properties are missing: email' }],
  },
  noOperation: {
    valid: false,
    errors: [{ location: 'operation', message: 'no operation found for GET /api/v1/unknown' }],
  },
  ambiguous: {
    valid: false,
    errors: [{
      location: 'operation',
      message: "ambiguous operation: GET /api/v1/profile?id=1 matches the APIs 'Profile API', 'Profile API v2'. Set 'api' to select one.",
    }],
  },
  unknownApi: { message: "api 'Unknown API' not found" },
};

test('serialization sends method, path with query, headers, status and API of a GET', async () => {
  const request = new Request('http://localhost:6006/api/profile?id=1', { headers: { Accept: 'application/json' } });
  const response = Response.json({ name: 'Jane Doe' }, { status: 201, headers: { 'X-Custom': 'a' } });
  assert.deepEqual(await serializePair(request, response, 'Profile API'), {
    api: 'Profile API',
    request: { method: 'GET', url: '/api/profile?id=1', headers: { accept: 'application/json' }, body: '' },
    response: {
      statusCode: 201,
      headers: { 'content-type': 'application/json', 'x-custom': 'a' },
      body: '{"name":"Jane Doe"}',
    },
  });
});

test('serialization sends the text body of a POST and omits the API when unset', async () => {
  const request = new Request('http://localhost:6006/api/profile', { method: 'POST', body: '{"name":"Jane"}' });
  const payload = await serializePair(request, new Response(null, { status: 204 }));
  assert.equal(payload.request.method, 'POST');
  assert.equal(payload.request.body, '{"name":"Jane"}');
  assert.equal(payload.response.body, '');
  assert.equal('api' in payload, false);
});

test('serialization sends an empty body when a body cannot be read', async () => {
  const request = new Request('http://localhost:6006/api/profile', { method: 'POST', body: 'x' });
  await request.text();
  const response = new Response('y');
  await response.text();
  const payload = await serializePair(request, response);
  assert.equal(payload.request.body, '');
  assert.equal(payload.response.body, '');
});

const classifyAnswer = (body, status = 200) => classify(dashboardUrl, Response.json(body, { status }));

test('classification tells valid from invalid responses', async () => {
  assert.deepEqual(await classifyAnswer(answers.valid), { status: 'valid', errors: [] });
  assert.deepEqual(await classifyAnswer(answers.invalid), { status: 'invalid', errors: answers.invalid.errors });
});

test('classification keeps Mokapi\'s message when no operation or several APIs match', async () => {
  assert.deepEqual(await classifyAnswer(answers.noOperation), {
    status: 'not-in-contract', errors: answers.noOperation.errors,
  });
  const ambiguous = await classifyAnswer(answers.ambiguous);
  assert.equal(ambiguous.status, 'not-in-contract');
  assert.match(ambiguous.errors[0].message, /ambiguous operation: .*'Profile API', 'Profile API v2'/);
});

test('classification reports an unknown API as configuration error with Mokapi\'s message', async () => {
  assert.deepEqual(await classifyAnswer(answers.unknownApi, 404), {
    status: 'config-error', message: "api 'Unknown API' not found",
  });
});

test('classification reports a Mokapi without the endpoint and asks for 0.58.0', async () => {
  for (const response of [
    new Response('404 page not found', { status: 404 }),
    new Response('Method Not Allowed', { status: 405 }),
    new Response('<html></html>', { status: 200 }),
  ]) {
    const outcome = await classify(dashboardUrl, response);
    assert.equal(outcome.status, 'endpoint-missing');
    assert.equal(
      outcome.message,
      'Mokapi at http://localhost:8080 does not support /api/services/http/validate. Update Mokapi to 0.58.0.',
    );
  }
});

test('classification reports other statuses as configuration error with the status', async () => {
  const outcome = await classifyAnswer({ message: 'invalid request.url' }, 400);
  assert.deepEqual(outcome, { status: 'config-error', message: 'Mokapi answered HTTP 400: invalid request.url' });
  assert.deepEqual(await classify(dashboardUrl, new Response('Oops', { status: 500 })), {
    status: 'config-error', message: 'Mokapi answered HTTP 500',
  });
});

test('classification reports a failed request as Mokapi not reachable with the URL', async () => {
  const outcome = await classify(dashboardUrl, new TypeError('Failed to fetch'));
  assert.equal(outcome.status, 'unreachable');
  assert.match(outcome.message, /Mokapi is not reachable at http:\/\/localhost:8080\. Check the dashboardUrl option/);
});

test('sending posts the JSON payload as a CORS simple request to the validate endpoint', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const payload = { request: { method: 'GET', url: '/api/profile' }, response: { statusCode: 200 } };
  const response = await sendValidation(dashboardUrl, payload);
  assert.equal(response.status, 200);
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'http://localhost:8080/api/services/http/validate');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'text/plain;charset=UTF-8' });
  assert.deepEqual(JSON.parse(init.body), payload);
});

// A stand-in for MSW's worker: events.on records the listeners, started() and mocked() play the events.
function fakeWorker() {
  const listeners = [];
  const play = (name, event) => listeners.filter(({ event: registered }) => registered === name).map(({ listener }) => listener(event));
  return {
    registrations: listeners,
    events: { on: (event, listener) => listeners.push({ event, listener }) },
    started: (request, requestId = 'id') => play('request:start', { request, requestId }),
    mocked: (request, response, requestId = 'id') => play('response:mocked', { request, response, requestId }),
  };
}

const storyContext = (worker, { id = 'profile--valid', validation = 'on', mokapi } = {}) => ({
  id,
  msw: worker,
  globals: { mokapiValidation: validation },
  parameters: mokapi === undefined ? {} : { mokapi },
});

const getProfile = () => new Request('http://localhost:6006/api/profile?id=1');
const jsonResponse = () => Response.json({ name: 'Jane Doe', email: 'jane@example.com' });

// Collects the actions that the hook sends to the panel and waits for the next one.
function recorder() {
  const actions = [];
  let waiting;
  return {
    actions,
    emit(action) {
      actions.push(action);
      waiting?.(action);
    },
    next: () => new Promise((resolve) => { waiting = resolve; }),
  };
}

const hookOptions = (panel) => ({ emit: panel.emit, dashboardUrl });

test('hook registers its listeners once per worker across repeated runs', () => {
  const worker = fakeWorker();
  const panel = recorder();
  for (let i = 0; i < 3; i++) validationHook(storyContext(worker), hookOptions(panel));
  assert.deepEqual(worker.registrations.map(({ event }) => event), ['request:start', 'response:mocked']);
  const otherWorker = fakeWorker();
  validationHook(storyContext(otherWorker), hookOptions(panel));
  assert.equal(otherWorker.registrations.length, 2);
});

test('hook announces every render with the story and a new render id', () => {
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker, { id: 'a--one' }), hookOptions(panel));
  validationHook(storyContext(worker, { id: 'a--two', validation: 'off' }), hookOptions(panel));
  const [first, second] = panel.actions;
  assert.deepEqual([first.type, first.storyId], ['render-started', 'a--one']);
  assert.deepEqual([second.type, second.storyId], ['render-started', 'a--two']);
  assert.ok(second.renderId > first.renderId);
});

test('listener sends the mocked pair with the API of the story and reports the result', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker, { mokapi: { api: 'Profile API' } }), hookOptions(panel));
  const { renderId } = panel.actions[0];
  const result = panel.next();
  worker.mocked(getProfile(), jsonResponse());
  const action = await result;
  const payload = JSON.parse(fetch.mock.calls[0].arguments[1].body);
  assert.equal(payload.api, 'Profile API');
  assert.equal(payload.request.url, '/api/profile?id=1');
  assert.equal(payload.response.statusCode, 200);
  assert.equal(action.type, 'result');
  assert.equal(action.renderId, renderId);
  assert.deepEqual(
    { ...action.entry, sequence: undefined, time: undefined },
    {
      sequence: undefined,
      time: undefined,
      method: 'GET',
      url: '/api/profile?id=1',
      statusCode: 200,
      status: 'invalid',
      errors: answers.invalid.errors,
    },
  );
  assert.equal(typeof action.entry.sequence, 'number');
  assert.equal(typeof action.entry.time, 'number');
});

test('a response is attributed to the render that started the request, not to a later one', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker, { id: 'a--one', mokapi: { api: 'Profile API' } }), hookOptions(panel));
  const firstRender = panel.actions[0].renderId;
  worker.started(getProfile(), 'first');
  validationHook(storyContext(worker, { id: 'a--one', mokapi: { api: 'Other API' } }), hookOptions(panel));
  const result = panel.next();
  worker.mocked(getProfile(), jsonResponse(), 'first');
  const action = await result;
  assert.equal(action.renderId, firstRender);
  assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).api, 'Profile API');
  const stale = reducePanel(reducePanel(initialPanelState, panel.actions[1]), action);
  assert.deepEqual(stale.entries, []);
});

test('a request that started while nothing was validated is not sent when the response comes later', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const worker = fakeWorker();
  validationHook(storyContext(worker, { validation: 'off' }), hookOptions(recorder()));
  worker.started(getProfile(), 'early');
  validationHook(storyContext(worker), hookOptions(recorder()));
  worker.mocked(getProfile(), jsonResponse(), 'early');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetch.mock.callCount(), 0);
});

test('listener leaves the original request and response unread for the application', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker), hookOptions(panel));
  const request = new Request('http://localhost:6006/api/profile', { method: 'POST', body: '{}' });
  const response = jsonResponse();
  const result = panel.next();
  worker.mocked(request, response);
  await result;
  assert.equal(request.bodyUsed, false);
  assert.equal(response.bodyUsed, false);
  assert.equal((await response.json()).name, 'Jane Doe');
});

test('listener returns before the validation request settles', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  const worker = fakeWorker();
  validationHook(storyContext(worker), hookOptions(recorder()));
  assert.deepEqual(worker.mocked(getProfile(), jsonResponse()), [undefined]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetch.mock.callCount(), 1);
});

test('nothing is sent while validation is off or the story is disabled', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker, { validation: 'off' }), hookOptions(panel));
  worker.mocked(getProfile(), jsonResponse());
  validationHook(storyContext(worker, { mokapi: { disable: true } }), hookOptions(panel));
  worker.mocked(getProfile(), jsonResponse());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(panel.actions.map(({ type }) => type), ['render-started', 'render-started']);
});

test('requests are attributed to the story that rendered last', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker, { id: 'a--one' }), hookOptions(panel));
  validationHook(storyContext(worker, { id: 'a--two' }), hookOptions(panel));
  const secondRender = panel.actions[1].renderId;
  const result = panel.next();
  worker.mocked(getProfile(), jsonResponse());
  assert.equal((await result).renderId, secondRender);
});

test('a Mokapi that cannot be reached is reported as entry and as notice of the same render', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker), hookOptions(panel));
  const { renderId } = panel.actions[0];
  const done = new Promise((resolve) => { panel.next().then(() => setImmediate(resolve)); });
  worker.mocked(getProfile(), jsonResponse());
  await done;
  const [, entryAction, noticeAction] = panel.actions;
  assert.deepEqual([entryAction.type, entryAction.renderId], ['result', renderId]);
  assert.equal(entryAction.entry.status, 'unreachable');
  assert.equal(entryAction.entry.url, '/api/profile?id=1');
  assert.match(entryAction.entry.message, /http:\/\/localhost:8080.*dashboardUrl/);
  assert.deepEqual([noticeAction.type, noticeAction.renderId, noticeAction.notice.kind], ['notice', renderId, 'unreachable']);
  assert.equal(noticeAction.notice.message, entryAction.entry.message);
});

test('without context.msw nothing happens while validation is off', () => {
  const panel = recorder();
  validationHook(storyContext(undefined, { validation: 'off' }), hookOptions(panel));
  validationHook({ id: 'a--one', globals: {}, parameters: {} }, hookOptions(panel));
  assert.deepEqual(panel.actions, []);
});

test('without context.msw validation on shows the notice once per render and does not throw', () => {
  const panel = recorder();
  for (const msw of [undefined, null, {}, { events: {} }]) {
    validationHook(storyContext(msw), hookOptions(panel));
  }
  const notices = panel.actions.filter(({ type }) => type === 'notice');
  assert.equal(notices.length, 4);
  assert.equal(notices[0].notice.kind, 'worker-missing');
  assert.equal(
    notices[0].notice.message,
    'MSW worker not found: `context.msw` is missing. Use `mswLoader` or set `context.msw` in your loader.',
  );
  assert.equal(notices[0].renderId, panel.actions[0].renderId);
});

test('a disabled story without context.msw shows no notice', () => {
  const panel = recorder();
  validationHook(storyContext(undefined, { mokapi: { disable: true } }), hookOptions(panel));
  assert.deepEqual(panel.actions, []);
});

const entry = (sequence, status = 'valid') => ({
  sequence, time: 1000 + sequence, method: 'GET', url: '/api/profile', statusCode: 200, status, errors: [],
});
const renderStarted = (renderId, storyId = 'a--one') => ({ type: 'render-started', storyId, renderId });
const resultOf = (renderId, sequence, status) => ({ type: 'result', renderId, entry: entry(sequence, status) });
const noticeOf = (renderId, kind, message = kind) => ({ type: 'notice', renderId, notice: { kind, message } });
const reduceAll = (...actions) => actions.reduce(reducePanel, initialPanelState);

test('panel starts empty and a render of a story clears its entries and notices', () => {
  assert.deepEqual(initialPanelState, { renderId: 0, entries: [], notices: [] });
  const state = reduceAll(renderStarted(1), resultOf(1, 1), noticeOf(1, 'unreachable'), renderStarted(2));
  assert.deepEqual(state, { storyId: 'a--one', renderId: 2, entries: [], notices: [] });
});

test('panel ignores answers of an earlier render', () => {
  const state = reduceAll(renderStarted(1), renderStarted(2, 'a--two'), resultOf(1, 1), noticeOf(1, 'unreachable'));
  assert.deepEqual([state.storyId, state.entries, state.notices], ['a--two', [], []]);
});

test('panel orders entries by capture sequence, not by arrival', () => {
  const state = reduceAll(renderStarted(1), resultOf(1, 3), resultOf(1, 1), resultOf(1, 2));
  assert.deepEqual(state.entries.map(({ sequence }) => sequence), [1, 2, 3]);
});

test('panel counts only invalid entries in the badge', () => {
  const state = reduceAll(
    renderStarted(1), resultOf(1, 1, 'valid'), resultOf(1, 2, 'invalid'),
    resultOf(1, 3, 'not-in-contract'), resultOf(1, 4, 'invalid'), resultOf(1, 5, 'unreachable'), noticeOf(1, 'config-error'),
  );
  assert.equal(invalidCount(state), 2);
  assert.equal(invalidCount(initialPanelState), 0);
});

test('panel keeps each notice once, whatever the number of requests', () => {
  const state = reduceAll(
    renderStarted(1),
    noticeOf(1, 'unreachable', 'Mokapi is not reachable'),
    noticeOf(1, 'unreachable', 'Mokapi is not reachable'),
    noticeOf(1, 'endpoint-missing'),
    noticeOf(1, 'config-error', "api 'x' not found"),
    noticeOf(1, 'worker-missing'),
  );
  assert.deepEqual(state.notices.map(({ kind }) => kind), ['unreachable', 'endpoint-missing', 'config-error', 'worker-missing']);
});

test('panel shows the results of the selected story only', () => {
  const state = reduceAll(renderStarted(1, 'a--one'), resultOf(1, 1));
  assert.equal(resultsOfStory(state, 'a--one'), state);
  assert.deepEqual(resultsOfStory(state, 'a--two'), initialPanelState);
});

test('preview toolbar toggles validation and starts with the value of defaultValidation', async () => {
  // Vite defines this constant at build time; defaultValidation true shows that it is read.
  globalThis.__MOKAPI_STORYBOOK_OPTIONS__ = { dashboardUrl: 'http://localhost:9090', defaultValidation: true };
  const { globalTypes, initialGlobals } = await import('../dist/preview.js');
  const { mokapiValidation } = globalTypes;
  assert.equal(mokapiValidation.description, 'Validate with Mokapi');
  assert.equal(mokapiValidation.toolbar.dynamicTitle, true);
  assert.deepEqual(mokapiValidation.toolbar.items.map(({ value }) => value), ['on', 'off']);
  assert.deepEqual(initialGlobals, { mokapiValidation: 'on' });
});

test('preview registers a beforeEach that sends results to the panel channel and the configured dashboard', async (t) => {
  const { addons } = await import('storybook/preview-api');
  const { beforeEach } = await import('../dist/preview.js');
  const emitted = [];
  addons.setChannel({ emit: (event, payload) => emitted.push({ event, payload }), on() {}, off() {} });
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const worker = fakeWorker();
  assert.equal(beforeEach(storyContext(worker, { id: 'a--preview' })), undefined);
  assert.deepEqual(emitted.map(({ event, payload }) => [event, payload.type, payload.storyId]), [
    ['mokapi/validation', 'render-started', 'a--preview'],
  ]);
  const result = new Promise((resolve) => { addons.getChannel().emit = (event, payload) => resolve({ event, payload }); });
  worker.mocked(getProfile(), jsonResponse());
  assert.equal((await result).payload.type, 'result');
  assert.equal(fetch.mock.calls[0].arguments[0], 'http://localhost:9090/api/services/http/validate');
});

test('preset adds the preview annotation and the manager entry after the existing ones', () => {
  assert.deepEqual(previewAnnotations(['a.js']).map((file) => file.split('/').at(-1)), ['a.js', 'preview.js']);
  assert.deepEqual(managerEntries().map((file) => file.split('/').at(-1)), ['manager.js']);
});

test('preset defines the resolved options for the preview and sets up no proxy', () => {
  const config = viteFinal({ server: { port: 6006 } }, { dashboardUrl: 'http://localhost:9090/', defaultValidation: true });
  assert.deepEqual(JSON.parse(config.define.__MOKAPI_STORYBOOK_OPTIONS__), {
    dashboardUrl: 'http://localhost:9090', defaultValidation: true,
  });
  assert.deepEqual(config.server, { port: 6006 });
  assert.equal(JSON.stringify(config).includes('proxy'), false);
  assert.deepEqual(JSON.parse(viteFinal({}).define.__MOKAPI_STORYBOOK_OPTIONS__), resolveOptions());
});

test('preset injects only the dashboard URL into the manager and escapes markup', () => {
  const head = managerHead('<title>x</title>', { dashboardUrl: 'http://localhost:9090/' });
  assert.ok(head.startsWith('<title>x</title>\n<script>'));
  assert.ok(head.includes('globalThis.__MOKAPI_PANEL_OPTIONS__ = {"dashboardUrl":"http://localhost:9090"};'));
  assert.equal(managerHead().includes('http://localhost:8080'), true);
  const escaped = managerHead('', { dashboardUrl: 'http://localhost:8080/?</script><script>alert(1)' });
  assert.equal(escaped.match(/<\/script>/g).length, 1);
  assert.ok(escaped.includes('\\u003c/script>'));
  assert.throws(() => managerHead('', { dashboardUrl: 'ftp://x' }), /Mokapi: dashboardUrl/);
});

test('core can be imported without MSW, which the package neither bundles nor requires', async () => {
  const [core, packageJson] = await Promise.all([
    import('../dist/index.js'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  assert.deepEqual(Object.keys(core), ['resolveOptions']);
  assert.equal(packageJson.peerDependencies.msw, undefined);
  assert.equal(packageJson.peerDependenciesMeta, undefined);
  assert.equal(packageJson.dependencies, undefined);
  assert.deepEqual(Object.keys(packageJson.exports), ['.', './preset']);
  const sources = await Promise.all(['listener', 'validation', 'results', 'preview', 'options', 'preset']
    .map((name) => readFile(new URL(`../dist/${name}.js`, import.meta.url), 'utf8')));
  assert.deepEqual(sources.filter((source) => /from ['"]msw/.test(source)), []);
});

test('manager bundle imports only modules that the Storybook manager provides as globals', async () => {
  const [{ globalPackages }, source] = await Promise.all([
    import('storybook/internal/manager/globals'),
    readFile(new URL('../dist/manager.js', import.meta.url), 'utf8'),
  ]);
  const imported = [...source.matchAll(/^(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const unsupported = imported.filter((specifier) => !specifier.startsWith('./') && !globalPackages.includes(specifier));
  assert.ok(imported.includes('react'));
  assert.deepEqual(unsupported, []);
});

const remountSteps = (...events) => events.reduce(
  ({ state, remounts }, event) => {
    const next = nextRemount(state, event);
    return { state: next.state, remounts: next.remount ? [...remounts, next.remount] : remounts };
  },
  { state: initialRemountState, remounts: [] },
).remounts;
const initialValidation = (validation) => ({ type: 'initial', validation });
const switched = (validation, storyId = 'a--one') => ({ type: 'switched', validation, storyId });
const finished = (storyId = 'a--one') => ({ type: 'finished', storyId });

test('a switch remounts the story once it has finished rendering, not before', () => {
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on')), []);
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on'), finished()), ['a--one']);
  assert.deepEqual(remountSteps(initialValidation('on'), switched('off'), finished()), ['a--one']);
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on'), finished(), finished()), ['a--one']);
});

test('nothing is remounted without a switch of the value', () => {
  assert.deepEqual(remountSteps(initialValidation('off'), finished()), []);
  assert.deepEqual(remountSteps(initialValidation('off'), switched('off'), finished()), []);
  assert.deepEqual(remountSteps(switched('on'), finished()), []);
  assert.deepEqual(remountSteps(initialValidation('off'), { type: 'switched', validation: 'on' }, finished()), []);
});

test('a story change or another story finishing cancels the pending remount', () => {
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on'), { type: 'story-changed' }, finished()), []);
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on'), finished('a--two')), []);
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on'), finished('a--two'), finished()), ['a--one']);
});
