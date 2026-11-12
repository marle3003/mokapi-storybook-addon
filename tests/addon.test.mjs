import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolveOptions } from '../dist/index.js';
import { initialPanelState, invalidCount, reducePanel, resultsOfStory } from '../dist/results.js';
import { previewAnnotations, managerEntries, managerHead, viteFinal } from '../dist/preset.js';
import { initialRemountState, nextRemount } from '../dist/remount.js';
import { toggleState } from '../dist/toggle.js';
import { testHook, validationHook } from '../dist/listener.js';
import { errorMessage, operationUrl, reportStatus, resolveTestMode, testModeText } from '../dist/report.js';
import { classify, sendValidation, serializePair } from '../dist/validation.js';

test('options default to the local Mokapi dashboard and validation off', () => {
  assert.deepEqual(resolveOptions(), { dashboardUrl: 'http://localhost:8080', defaultValidation: false, defaultTest: 'todo' });
  assert.deepEqual(resolveOptions({}), resolveOptions());
});

test('options keep the given values and strip trailing slashes from the dashboard URL', () => {
  assert.deepEqual(
    resolveOptions({ dashboardUrl: 'https://mokapi.example.com/', defaultValidation: true }),
    { dashboardUrl: 'https://mokapi.example.com', defaultValidation: true, defaultTest: 'todo' },
  );
});

test('options accept the test modes error, todo and off and reject anything else', () => {
  for (const defaultTest of ['error', 'todo', 'off']) assert.equal(resolveOptions({ defaultTest }).defaultTest, defaultTest);
  for (const defaultTest of ['strict', '', true, null]) {
    assert.throws(() => resolveOptions({ defaultTest }), /^Error: Mokapi: defaultTest must be 'error', 'todo' or 'off'\.$/);
  }
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
  assert.deepEqual(await classifyAnswer(answers.valid), { status: 'valid', errors: [], operation: answers.valid.operation });
  assert.deepEqual(await classifyAnswer(answers.invalid), {
    status: 'invalid', errors: answers.invalid.errors, operation: answers.invalid.operation,
  });
});

test('classification keeps the matched operation of valid and invalid answers only', async () => {
  assert.deepEqual((await classifyAnswer(answers.valid)).operation, { api: 'Profile API', method: 'GET', path: '/profile' });
  assert.deepEqual((await classifyAnswer(answers.invalid)).operation, { api: 'Profile API', method: 'GET', path: '/profile' });
  assert.equal('operation' in await classifyAnswer(answers.noOperation), false);
  assert.equal('operation' in await classifyAnswer(answers.ambiguous), false);
});

test('operation URL points to the dashboard page of the operation with encoded API name and path segments', () => {
  assert.equal(
    operationUrl('http://localhost:8080', { api: 'Profile API', method: 'GET', path: '/profile/{id}' }),
    'http://localhost:8080/dashboard/http/services/Profile%20API/profile/%7Bid%7D/get',
  );
  assert.equal(
    operationUrl('https://mokapi.example.com', { api: 'Shop/EU', method: 'POST', path: '/orders/{orderId}/items' }),
    'https://mokapi.example.com/dashboard/http/services/Shop%2FEU/orders/%7BorderId%7D/items/post',
  );
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
    bypassed: (request, requestId = 'id') => play('response:bypass', { request, response: new Response(), requestId }),
    unhandled: (request, requestId = 'id') => play('request:unhandled', { request, requestId }),
    threw: (request, requestId = 'id') => play('unhandledException', { error: new Error('handler failed'), request, requestId }),
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

const hookOptions = (panel, defaultTest = 'todo') => ({ emit: panel.emit, dashboardUrl, defaultTest });

test('hook registers its listeners once per worker across repeated runs', () => {
  const worker = fakeWorker();
  const panel = recorder();
  for (let i = 0; i < 3; i++) validationHook(storyContext(worker), hookOptions(panel));
  assert.deepEqual(worker.registrations.map(({ event }) => event), [
    'request:start', 'response:mocked', 'response:bypass', 'request:unhandled', 'unhandledException',
  ]);
  const otherWorker = fakeWorker();
  validationHook(storyContext(otherWorker), hookOptions(panel));
  assert.equal(otherWorker.registrations.length, 5);
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

test('hook announces the resolved test mode while validating, also without a worker or with an invalid parameter', () => {
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker, { id: 'a--default' }), hookOptions(panel, 'todo'));
  validationHook(storyContext(worker, { id: 'a--error', mokapi: { test: 'error' } }), hookOptions(panel, 'todo'));
  validationHook(storyContext(worker, { id: 'a--off', mokapi: { test: 'off' } }), hookOptions(panel, 'error'));
  validationHook(storyContext(worker, { id: 'a--invalid', mokapi: { test: 'strict' } }), hookOptions(panel, 'error'));
  validationHook(storyContext(undefined, { id: 'a--no-worker', mokapi: { test: 'error' } }), hookOptions(panel, 'todo'));
  const started = panel.actions.filter(({ type }) => type === 'render-started');
  assert.deepEqual(started.map(({ storyId, testMode }) => [storyId, testMode]), [
    ['a--default', 'todo'], ['a--error', 'error'], ['a--off', 'off'], ['a--invalid', 'error'], ['a--no-worker', 'error'],
  ]);
});

test('hook announces no test mode with validation off or for a disabled story', () => {
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker, { validation: 'off', mokapi: { test: 'error' } }), hookOptions(panel));
  validationHook(storyContext(worker, { mokapi: { disable: true, test: 'error' } }), hookOptions(panel));
  assert.equal(panel.actions.length, 2);
  for (const action of panel.actions) assert.equal('testMode' in action, false);
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
      operation: answers.invalid.operation,
      operationUrl: 'http://localhost:8080/dashboard/http/services/Profile%20API/profile/get',
    },
  );
  assert.equal(typeof action.entry.sequence, 'number');
  assert.equal(typeof action.entry.time, 'number');
});

test('listener leaves the operation out of entries that Mokapi did not match', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.noOperation));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker), hookOptions(panel));
  const result = panel.next();
  worker.mocked(getProfile(), jsonResponse());
  const { entry } = await result;
  assert.equal(entry.status, 'not-in-contract');
  assert.equal('operation' in entry || 'operationUrl' in entry, false);
  fetch.mock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
  const unreachable = panel.next();
  worker.mocked(getProfile(), jsonResponse(), 'other');
  assert.equal('operationUrl' in (await unreachable).entry, false);
});

const invalidEntry = (overrides = {}) => ({
  sequence: 1,
  time: 0,
  method: 'GET',
  url: '/api/profile/1',
  statusCode: 200,
  status: 'invalid',
  errors: [{ location: 'response.body', message: "missing required property 'name'" }],
  operation: { api: 'Profile API', method: 'GET', path: '/profile/{id}' },
  operationUrl: 'http://localhost:8080/dashboard/http/services/Profile%20API/profile/%7Bid%7D/get',
  ...overrides,
});
const validEntry = () => invalidEntry({ status: 'valid', errors: [] });
const notInContractEntry = () => ({ ...invalidEntry({ status: 'not-in-contract' }), operation: undefined, operationUrl: undefined });
const panelNotice = (kind, message = `${kind} message`) => ({ kind, message });
const stateOf = (entries = [], notices = []) => ({ ...initialPanelState, entries, notices });

test('the test mode of a story is its parameter, an invalid parameter falls back to the default and is flagged', () => {
  assert.deepEqual(resolveTestMode(undefined, 'todo'), { mode: 'todo', invalid: false });
  assert.deepEqual(resolveTestMode('error', 'todo'), { mode: 'error', invalid: false });
  assert.deepEqual(resolveTestMode('off', 'error'), { mode: 'off', invalid: false });
  assert.deepEqual(resolveTestMode('strict', 'error'), { mode: 'error', invalid: true });
  assert.deepEqual(resolveTestMode(true, 'off'), { mode: 'off', invalid: true });
});

test('the panel explains what each test mode does', () => {
  assert.equal(testModeText('error'), 'Test mode: error. Contract errors make this story fail.');
  assert.equal(testModeText('todo'), 'Test mode: todo. Contract errors are reported as warnings, the story stays green.');
  assert.equal(testModeText('off'), 'Test mode: off. Contract errors are shown here only.');
});

test('report status is failed in error mode and warning in todo mode for every failing result', () => {
  const failing = [
    stateOf([invalidEntry()]),
    stateOf([], [panelNotice('unreachable')]),
    stateOf([], [panelNotice('endpoint-missing')]),
    stateOf([], [panelNotice('config-error')]),
    stateOf([], [panelNotice('timeout')]),
  ];
  for (const state of failing) {
    assert.equal(reportStatus(state, 'error'), 'failed');
    assert.equal(reportStatus(state, 'todo'), 'warning');
  }
});

test('report status ignores results that are not in the contract, a missing worker and stories without requests', () => {
  for (const state of [
    initialPanelState,
    stateOf([validEntry(), notInContractEntry()]),
    stateOf([], [panelNotice('worker-missing')]),
  ]) {
    assert.equal(reportStatus(state, 'error'), 'passed');
    assert.equal(reportStatus(state, 'todo'), 'passed');
  }
});

test('error message names the count, the request, the operation with its dashboard page and the errors', () => {
  assert.equal(errorMessage(stateOf([invalidEntry()])), [
    'Mokapi: 1 response does not match the contract.',
    '',
    'GET /api/profile/1 -> GET /profile/{id} (http://localhost:8080/dashboard/http/services/Profile%20API/profile/%7Bid%7D/get)',
    "  response.body: missing required property 'name'",
  ].join('\n'));
});

test('error message counts only invalid entries and uses the plural', () => {
  const second = invalidEntry({ sequence: 2, url: '/api/profile/2', errors: [
    { location: 'response.status', message: 'status 500 not defined' },
    { location: 'response.body', message: 'not valid' },
  ] });
  const requestLine = (id) => `GET /api/profile/${id} -> GET /profile/{id} (http://localhost:8080/dashboard/http/services/Profile%20API/profile/%7Bid%7D/get)`;
  assert.equal(errorMessage(stateOf([validEntry(), invalidEntry(), notInContractEntry(), second])), [
    'Mokapi: 2 responses do not match the contract.',
    '',
    requestLine(1),
    "  response.body: missing required property 'name'",
    requestLine(2),
    '  response.status: status 500 not defined',
    '  response.body: not valid',
  ].join('\n'));
});

test('error message lists the failing notices with their panel text and starts with the first one when nothing is invalid', () => {
  const notices = [panelNotice('worker-missing'), panelNotice('unreachable', 'not reachable'), panelNotice('timeout', 'timeout (GET /a).'), panelNotice('timeout', 'timeout (GET /b).')];
  assert.equal(errorMessage(stateOf([validEntry()], notices)), 'not reachable\ntimeout (GET /a).\ntimeout (GET /b).');
  assert.equal(
    errorMessage(stateOf([invalidEntry()], [panelNotice('config-error', 'api not found')])).split('\n').at(-1),
    'api not found',
  );
});

test('a response without a matched operation is listed by its request only', () => {
  const entry = invalidEntry({ operation: undefined, operationUrl: undefined });
  assert.equal(errorMessage(stateOf([entry])).split('\n')[2], 'GET /api/profile/1');
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

// The context Storybook passes to beforeEach and afterEach: the same object, with the abort signal and the reporting API.
function testContext(worker, options) {
  const reports = [];
  const controller = new AbortController();
  return {
    ...storyContext(worker, options),
    abortSignal: controller.signal,
    reporting: { addReport: (report) => reports.push(report) },
    reports,
    abort: () => controller.abort(),
  };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));
const failingMode = { mokapi: { test: 'error' } };

test('afterEach waits for a delayed response and its validation before it reports', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker);
  validationHook(context, hookOptions(panel));
  worker.started(getProfile());
  let done = false;
  const finished = testHook(context, hookOptions(panel)).then(() => { done = true; });
  await settled();
  assert.equal(done, false);
  worker.mocked(getProfile(), jsonResponse());
  await finished;
  assert.deepEqual(context.reports.map(({ type, version, status }) => [type, version, status]), [['mokapi', 1, 'warning']]);
  assert.deepEqual(context.reports[0].result.entries.map(({ status }) => status), ['invalid']);
});

test('afterEach in error mode adds a failed report and throws the message of the invalid responses', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker, { mokapi: { test: 'error' } });
  validationHook(context, hookOptions(panel));
  worker.started(getProfile());
  const finished = testHook(context, hookOptions(panel));
  worker.mocked(getProfile(), jsonResponse());
  await assert.rejects(finished, {
    message: [
      'Mokapi: 1 response does not match the contract.',
      '',
      'GET /api/profile?id=1 -> GET /profile (http://localhost:8080/dashboard/http/services/Profile%20API/profile/get)',
      '  response.body: required properties are missing: email',
    ].join('\n'),
  });
  assert.equal(context.reports[0].status, 'failed');
});

test('afterEach does not wait for requests that MSW bypasses', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  for (const drop of ['bypassed', 'unhandled']) {
    const panel = recorder();
    const worker = fakeWorker();
    const context = testContext(worker, failingMode);
    validationHook(context, hookOptions(panel));
    worker.started(getProfile(), 'dropped');
    const finished = testHook(context, hookOptions(panel));
    worker[drop](getProfile(), 'dropped');
    await finished;
    assert.equal(context.reports[0].status, 'passed', drop);
    // The request no longer belongs to the render that started it.
    validationHook(testContext(worker), hookOptions(panel));
    const secondRender = panel.actions.at(-1).renderId;
    const result = panel.next();
    worker.mocked(getProfile(), jsonResponse(), 'dropped');
    assert.equal((await result).renderId, secondRender, drop);
  }
  assert.equal(fetch.mock.callCount(), 2);
});

test('afterEach does not wait for a request whose handler throws', async () => {
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(recorder()));
  worker.started(getProfile(), 'thrown');
  const finished = testHook(context, hookOptions(recorder()));
  worker.threw(getProfile(), 'thrown');
  await finished;
  assert.equal(context.reports[0].status, 'passed');
});

test('the 500 that MSW answers for a throwing handler is not validated', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(panel));
  worker.started(getProfile(), 'thrown');
  const finished = testHook(context, hookOptions(panel));
  worker.threw(getProfile(), 'thrown');
  worker.mocked(getProfile(), Response.json({ message: 'handler failed' }, { status: 500 }), 'thrown');
  await finished;
  await settled();
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(context.reports[0].status, 'passed');
  assert.deepEqual(panel.actions.map(({ type }) => type), ['render-started']);
});

test('a validation that does not finish within 4 s fails with one notice per request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(panel));
  worker.started(getProfile(), 'one');
  worker.started(new Request('http://localhost:6006/api/orders'), 'two');
  const finished = testHook(context, hookOptions(panel));
  t.mock.timers.tick(3999);
  assert.deepEqual(panel.actions.map(({ type }) => type), ['render-started']);
  t.mock.timers.tick(1);
  await assert.rejects(finished, {
    message: [
      'Mokapi validation did not finish within 4 s (GET /api/profile?id=1).',
      'Mokapi validation did not finish within 4 s (GET /api/orders).',
    ].join('\n'),
  });
  assert.deepEqual(panel.actions.slice(1).map(({ notice }) => notice.kind), ['timeout', 'timeout']);
  assert.equal(context.reports[0].status, 'failed');
  assert.equal(context.reports[0].result.notices.length, 2);
});

const tick = async (t, milliseconds) => { t.mock.timers.tick(milliseconds); await settled(); };
const requestTo = (path) => new Request(`http://localhost:6006${path}`);

test('afterEach counts a request that starts within the quiet window of 100 ms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker);
  validationHook(context, hookOptions(panel));
  let done = false;
  const finished = testHook(context, hookOptions(panel)).then(() => { done = true; });
  await tick(t, 50);
  worker.started(getProfile(), 'early');
  await tick(t, 99);
  assert.equal(done, false);
  await tick(t, 1);
  assert.equal(done, false, 'the request that started 50 ms after afterEach is waited for');
  worker.mocked(getProfile(), jsonResponse(), 'early');
  await finished;
  assert.deepEqual(context.reports[0].result.entries.map(({ status }) => status), ['invalid']);
});

test('afterEach ignores a request that starts after the quiet window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(recorder()));
  const finished = testHook(context, hookOptions(recorder()));
  t.mock.timers.tick(100);
  await finished;
  worker.started(getProfile(), 'late');
  assert.equal(context.reports[0].status, 'passed');
});

test('the quiet window ends after 1 s even if requests keep starting, and the 4 s limit counts from the start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(recorder()));
  const finished = testHook(context, hookOptions(recorder()));
  for (let i = 0; i < 11; i++) {
    await tick(t, 90);
    worker.started(requestTo(`/api/stream${i}`), `stream${i}`);
  }
  await tick(t, 10);
  worker.started(requestTo('/api/after'), 'after');
  await tick(t, 2999);
  t.mock.timers.tick(1);
  const lines = await finished.then(() => [], (error) => error.message.split('\n'));
  assert.equal(lines.length, 11);
  assert.ok(lines.every((line) => /did not finish within 4 s \(GET \/api\/stream\d+\)\.$/.test(line)), lines.join('\n'));
});

test('a request that starts in the quiet window times out 4 s after afterEach began', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(recorder()));
  let settledAt;
  const finished = testHook(context, hookOptions(recorder())).catch(() => { settledAt = 'rejected'; });
  await tick(t, 50);
  worker.started(getProfile(), 'early');
  await tick(t, 3949);
  assert.equal(settledAt, undefined);
  await tick(t, 1);
  await finished;
  assert.equal(settledAt, 'rejected');
});

test('afterEach returns without a report when the story is torn down during the quiet window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = testContext(fakeWorker(), failingMode);
  validationHook(context, hookOptions(recorder()));
  const finished = testHook(context, hookOptions(recorder()));
  await tick(t, 50);
  context.abort();
  assert.equal(await finished, undefined);
  assert.deepEqual(context.reports, []);
});

test('a timeout does not stop a story in todo mode', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = fakeWorker();
  const context = testContext(worker);
  validationHook(context, hookOptions(recorder()));
  worker.started(getProfile());
  const finished = testHook(context, hookOptions(recorder()));
  t.mock.timers.tick(4000);
  await finished;
  assert.equal(context.reports[0].status, 'warning');
});

test('afterEach returns without a report when the story is torn down while it waits', async () => {
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(recorder()));
  worker.started(getProfile());
  const finished = testHook(context, hookOptions(recorder()));
  context.abort();
  assert.equal(await finished, undefined);
  assert.deepEqual(context.reports, []);
  assert.equal(await testHook(context, hookOptions(recorder())), undefined);
  assert.deepEqual(context.reports, []);
});

test('the report holds only the entries and notices of its own render', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  const first = testContext(worker);
  validationHook(first, hookOptions(panel));
  worker.started(getProfile(), 'first');
  const result = panel.next();
  worker.mocked(getProfile(), jsonResponse(), 'first');
  await result;
  const second = testContext(worker);
  validationHook(second, hookOptions(panel));
  worker.started(new Request('http://localhost:6006/api/orders'), 'second');
  const finished = testHook(second, hookOptions(panel));
  worker.mocked(new Request('http://localhost:6006/api/orders'), jsonResponse(), 'second');
  await finished;
  assert.deepEqual(second.reports[0].result.entries.map(({ url }) => url), ['/api/orders']);
  assert.deepEqual(second.reports[0].result.notices, []);
});

// Storybook runs beforeEach and afterEach again when globals or args change: a new context object, but the same
// StoryRender and so the same abortSignal. A mount (first render, story change, remount) gets a new signal.
const rerenderOf = (mounted, worker, options) => ({ ...testContext(worker, options), abortSignal: mounted.abortSignal });

test('a re-render of the mounted story keeps the entries of the mount in the panel', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  const mounted = testContext(worker);
  validationHook(mounted, hookOptions(panel));
  worker.started(getProfile(), 'mount');
  const result = panel.next();
  worker.mocked(getProfile(), jsonResponse(), 'mount');
  await result;

  validationHook(rerenderOf(mounted, worker), hookOptions(panel));

  const shown = panel.actions.reduce(reducePanel, initialPanelState);
  assert.deepEqual(shown.entries.map(({ status, url }) => [status, url]), [['invalid', '/api/profile?id=1']]);
});

test('a re-render of the mounted story appends the entries of its own requests to those of the mount', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  const mounted = testContext(worker);
  validationHook(mounted, hookOptions(panel));
  worker.started(getProfile(), 'mount');
  let result = panel.next();
  worker.mocked(getProfile(), jsonResponse(), 'mount');
  await result;

  validationHook(rerenderOf(mounted, worker), hookOptions(panel));
  worker.started(requestTo('/api/orders'), 'rerender');
  result = panel.next();
  worker.mocked(requestTo('/api/orders'), jsonResponse(), 'rerender');
  await result;

  const shown = panel.actions.reduce(reducePanel, initialPanelState);
  assert.deepEqual(shown.entries.map(({ url }) => url), ['/api/profile?id=1', '/api/orders']);
});

test('afterEach of a re-render in error mode fails on the invalid entry of the mount', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  const mounted = testContext(worker, failingMode);
  validationHook(mounted, hookOptions(panel));
  worker.started(getProfile(), 'mount');
  const finishedMount = testHook(mounted, hookOptions(panel));
  worker.mocked(getProfile(), jsonResponse(), 'mount');
  await assert.rejects(finishedMount, /^Error: Mokapi: 1 response does not match the contract\./);

  const rerender = rerenderOf(mounted, worker, failingMode);
  validationHook(rerender, hookOptions(panel));
  await assert.rejects(testHook(rerender, hookOptions(panel)), /^Error: Mokapi: 1 response does not match the contract\./);
  assert.equal(rerender.reports[0].status, 'failed');
});

test('a re-render that switches validation off does not judge the results of the mount', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  const mounted = testContext(worker, failingMode);
  validationHook(mounted, hookOptions(panel));
  worker.started(getProfile(), 'mount');
  const result = panel.next();
  worker.mocked(getProfile(), jsonResponse(), 'mount');
  await result;

  const rerender = rerenderOf(mounted, worker, { ...failingMode, validation: 'off' });
  validationHook(rerender, hookOptions(panel));

  assert.equal(await testHook(rerender, hookOptions(panel)), undefined);
  assert.deepEqual(rerender.reports, []);
});

test('a re-render that switches validation on starts a new list like a mount', async () => {
  const panel = recorder();
  const worker = fakeWorker();
  const mounted = testContext(worker, { validation: 'off' });
  validationHook(mounted, hookOptions(panel));
  const before = panel.actions.length;

  validationHook(rerenderOf(mounted, worker, { validation: 'on' }), hookOptions(panel));

  assert.deepEqual(panel.actions.slice(before).map(({ type }) => type), ['render-started']);
});

test('a remount of the story has a new abortSignal and starts a new list', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  const mounted = testContext(worker);
  validationHook(mounted, hookOptions(panel));
  worker.started(getProfile(), 'first');
  let result = panel.next();
  worker.mocked(getProfile(), jsonResponse(), 'first');
  await result;

  validationHook(testContext(worker), hookOptions(panel));
  worker.started(requestTo('/api/orders'), 'second');
  result = panel.next();
  worker.mocked(requestTo('/api/orders'), jsonResponse(), 'second');
  await result;

  const shown = panel.actions.reduce(reducePanel, initialPanelState);
  assert.deepEqual(shown.entries.map(({ url }) => url), ['/api/orders']);
});

test('a context without abortSignal is a mount, so every render of it starts a new list', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker), hookOptions(panel));
  worker.started(getProfile(), 'first');
  const result = panel.next();
  worker.mocked(getProfile(), jsonResponse(), 'first');
  await result;

  validationHook(storyContext(worker), hookOptions(panel));

  assert.deepEqual(panel.actions.reduce(reducePanel, initialPanelState).entries, []);
});

test('the answer for a request of the previous mount does not reach the list of the new mount', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(testContext(worker), hookOptions(panel));
  worker.started(getProfile(), 'old');
  validationHook(testContext(worker), hookOptions(panel));
  worker.mocked(getProfile(), jsonResponse(), 'old');
  await settled();
  await settled();

  const shown = panel.actions.reduce(reducePanel, initialPanelState);
  assert.deepEqual(shown.entries, []);
});

test('an invalid test parameter is a configuration error and the story uses defaultTest', async () => {
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker, { mokapi: { test: 'strict' } });
  validationHook(context, hookOptions(panel, 'error'));
  assert.deepEqual(panel.actions.slice(1).map(({ type, notice }) => [type, notice.kind, notice.message]), [
    ['notice', 'config-error', "Mokapi: parameters.mokapi.test must be 'error', 'todo' or 'off'."],
  ]);
  await assert.rejects(testHook(context, hookOptions(panel, 'error')), /^Error: Mokapi: parameters\.mokapi\.test must be 'error', 'todo' or 'off'\.$/);
  assert.equal(context.reports[0].status, 'failed');

  const todo = testContext(worker, { mokapi: { test: 'strict' } });
  validationHook(todo, hookOptions(panel, 'todo'));
  await testHook(todo, hookOptions(panel, 'todo'));
  assert.equal(todo.reports[0].status, 'warning');
});

test('afterEach adds no report with validation off, for a disabled story or in off mode and never fails then', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  for (const options of [
    { validation: 'off', mokapi: { test: 'error' } },
    { mokapi: { disable: true, test: 'error' } },
    { mokapi: { test: 'off' } },
  ]) {
    const worker = fakeWorker();
    const context = testContext(worker, options);
    validationHook(context, hookOptions(recorder()));
    worker.started(getProfile());
    worker.mocked(getProfile(), jsonResponse());
    assert.equal(await testHook(context, hookOptions(recorder())), undefined);
    assert.deepEqual(context.reports, []);
  }
  assert.equal(await testHook(testContext(fakeWorker()), hookOptions(recorder())), undefined);
});

test('afterEach in error mode does not fail without a worker, without requests or for results outside the contract', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.noOperation));
  const withoutWorker = testContext(undefined, failingMode);
  validationHook(withoutWorker, hookOptions(recorder()));
  await testHook(withoutWorker, hookOptions(recorder()));
  assert.equal(withoutWorker.reports[0].status, 'passed');

  const worker = fakeWorker();
  const noRequest = testContext(worker, failingMode);
  validationHook(noRequest, hookOptions(recorder()));
  await testHook(noRequest, hookOptions(recorder()));
  assert.equal(noRequest.reports[0].status, 'passed');

  const panel = recorder();
  const notInContract = testContext(worker, failingMode);
  validationHook(notInContract, hookOptions(panel));
  worker.started(getProfile());
  const finished = testHook(notInContract, hookOptions(panel));
  worker.mocked(getProfile(), jsonResponse());
  await finished;
  assert.equal(notInContract.reports[0].status, 'passed');
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

test('panel keeps the test mode of the render and resets it with the next render', () => {
  const started = (renderId, testMode) => ({ ...renderStarted(renderId), ...(testMode && { testMode }) });
  assert.equal(reduceAll(started(1, 'error')).testMode, 'error');
  assert.equal(reduceAll(started(1, 'error'), resultOf(1, 1, 'invalid'), noticeOf(1, 'timeout')).testMode, 'error');
  assert.equal('testMode' in reduceAll(started(1, 'error'), started(2)), false);
  assert.equal('testMode' in initialPanelState, false);
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

test('preview starts with the value of defaultValidation and renders no Storybook dropdown', async () => {
  // Vite defines this constant at build time; defaultValidation true shows that it is read.
  globalThis.__MOKAPI_STORYBOOK_OPTIONS__ = { dashboardUrl: 'http://localhost:9090', defaultValidation: true };
  const { globalTypes, initialGlobals } = await import('../dist/preview.js');
  assert.deepEqual(initialGlobals, { mokapiValidation: 'on' });
  // A globalType with `toolbar` would make Storybook render its own dropdown next to the manager's toggle.
  assert.equal(globalTypes, undefined);
});

test('toggle is pressed and turns validation off while it is on, otherwise it turns validation on', () => {
  assert.deepEqual(toggleState('on'), { pressed: true, next: 'off', tooltip: 'Mokapi validation is on. Click to turn off.' });
  assert.deepEqual(toggleState('off'), { pressed: false, next: 'on', tooltip: 'Mokapi validation is off. Click to turn on.' });
  assert.deepEqual(toggleState(undefined), toggleState('off'));
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

test('preview registers an afterEach that fails a story with a contract error in error mode and warns in todo mode', async (t) => {
  const { addons } = await import('storybook/preview-api');
  const { afterEach, beforeEach } = await import('../dist/preview.js');
  addons.setChannel({ emit() {}, on() {}, off() {} });
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const worker = fakeWorker();
  const run = async (mokapi) => {
    const context = testContext(worker, { mokapi });
    beforeEach(context);
    worker.started(getProfile());
    const finished = afterEach(context);
    worker.mocked(getProfile(), jsonResponse());
    return { context, finished };
  };
  const failing = await run({ test: 'error' });
  await assert.rejects(failing.finished, /^Error: Mokapi: 1 response does not match the contract\./);
  assert.equal(failing.context.reports[0].status, 'failed');
  const todo = await run({});
  assert.equal(await todo.finished, undefined);
  assert.equal(todo.context.reports[0].status, 'warning');
});

test('preset adds the preview annotation and the manager entry after the existing ones', () => {
  assert.deepEqual(previewAnnotations(['a.js']).map((file) => file.split('/').at(-1)), ['a.js', 'preview.js']);
  assert.deepEqual(managerEntries().map((file) => file.split('/').at(-1)), ['manager.js']);
});

test('preset defines the resolved options for the preview and sets up no proxy', () => {
  const config = viteFinal({ server: { port: 6006 } }, { dashboardUrl: 'http://localhost:9090/', defaultValidation: true });
  assert.deepEqual(JSON.parse(config.define.__MOKAPI_STORYBOOK_OPTIONS__), {
    dashboardUrl: 'http://localhost:9090', defaultValidation: true, defaultTest: 'todo',
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
const started = (storyId = 'a--one') => ({ type: 'started', storyId });
const finished = (storyId = 'a--one') => ({ type: 'finished', storyId });

test('a switch remounts the story once it has finished rendering, not before', () => {
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on')), []);
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on'), started()), []);
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on'), started(), finished()), ['a--one']);
  assert.deepEqual(remountSteps(initialValidation('on'), switched('off'), started(), finished()), ['a--one']);
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on'), started(), finished(), finished()), ['a--one']);
});

// Storybook enqueues the re-render of a story that is still rendering when the global changes, and
// runs it after the running render has finished. That STORY_FINISHED is not the one of the
// re-render that already applied the switch, and a remount at that moment aborts the re-render.
test('a render that was already running at the switch does not trigger the remount', () => {
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on'), finished()), []);
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on'), finished(), started()), []);
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on'), finished(), started(), finished()), ['a--one']);
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on'), finished(), started(), finished(), finished()), ['a--one']);
});

// Storybook starts the re-render at once while the story is playing, completing or completed. The initial
// render is still running then, so the events are started(initial), switched, started(new), finished(old), finished(new).
test('a switch while the story finishes its render remounts after the re-render has finished', () => {
  const beforeSecondFinished = [initialValidation('off'), started(), switched('on'), started(), finished()];
  assert.deepEqual(remountSteps(...beforeSecondFinished), []);
  assert.deepEqual(remountSteps(...beforeSecondFinished, finished()), ['a--one']);
  assert.deepEqual(remountSteps(...beforeSecondFinished, finished(), finished()), ['a--one']);
});

// The re-render starts at once over a render that has settled. Its `finished` is the only one after the switch.
test('a switch after the story has finished its render remounts after the re-render has finished', () => {
  const beforeFinished = [initialValidation('off'), started(), finished(), switched('on'), started()];
  assert.deepEqual(remountSteps(...beforeFinished), []);
  assert.deepEqual(remountSteps(...beforeFinished, finished()), ['a--one']);
});

test('a switch while the story is pending remounts after the enqueued re-render has finished', () => {
  const beforeEnqueuedStart = [initialValidation('off'), started(), switched('on'), finished()];
  assert.deepEqual(remountSteps(...beforeEnqueuedStart), []);
  assert.deepEqual(remountSteps(...beforeEnqueuedStart, started()), []);
  assert.deepEqual(remountSteps(...beforeEnqueuedStart, started(), finished()), ['a--one']);
});

// Enqueued: switched(on), started(new), switched(off), finished(new), started(new), finished.
// Immediate: switched(on), started(new), switched(off), started(new), finished(old), finished(new).
test('a second switch while the re-render runs remounts once after the latest re-render has finished', () => {
  const enqueued = [initialValidation('off'), started(), switched('on'), finished(), started(), switched('off')];
  assert.deepEqual(remountSteps(...enqueued, finished()), []);
  assert.deepEqual(remountSteps(...enqueued, finished(), started(), finished()), ['a--one']);
  const immediate = [initialValidation('off'), started(), switched('on'), started(), switched('off'), started()];
  assert.deepEqual(remountSteps(...immediate, finished()), []);
  assert.deepEqual(remountSteps(...immediate, finished(), finished()), ['a--one']);
});

test('a story change clears the running render, so a later switch does not skip a finished', () => {
  const afterStoryChange = [initialValidation('off'), started(), { type: 'story-changed' }, switched('on'), started()];
  assert.deepEqual(remountSteps(...afterStoryChange, finished()), ['a--one']);
});

test('a render of another story that is running does not make the switch wait for another finished', () => {
  const beforeFinished = [initialValidation('off'), started('a--two'), switched('on'), started()];
  assert.deepEqual(remountSteps(...beforeFinished, finished()), ['a--one']);
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
  assert.deepEqual(remountSteps(initialValidation('off'), switched('on'), started(), finished('a--two'), finished()), ['a--one']);
});
