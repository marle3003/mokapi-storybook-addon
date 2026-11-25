import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolveOptions } from '../dist/index.js';
import { isDisabled } from '../dist/options.js';
import { forgetResults, initialPanelState, invalidCount, panelOfStory, reducePanel, reduceStoryPanels, rememberResult, resultsOfStory, uiResultOf, validCount } from '../dist/results.js';
import { previewAnnotations, managerEntries, managerHead, viteFinal } from '../dist/preset.js';
import { initialRemountState, nextRemount, remountIfSelected } from '../dist/remount.js';
import { initialRendering, isRendering, nextRendering } from '../dist/rendering.js';
import { applyTestRun, forgetStoryRun, overtakeMounts, panelOf, ranStoryIds, readTestRun, readTestRunEvent, releaseOvertaken, settleReport, startValidatingMount, testRunResults } from '../dist/test-run.js';
import { toggleState } from '../dist/toggle.js';
import { MokapiContractError, testHook, validationHook } from '../dist/listener.js';
import {
  BODY_LIMIT,
  CONTRACT_ERROR_PREFIX,
  contextMenuRow,
  contractCheckboxTooltip,
  DISABLED_HINT,
  DOCS_URL,
  errorMessage,
  formatBody,
  formatTime,
  handlerTimeoutMessage,
  headline,
  DASHBOARD_LINK_LABEL,
  HELP_ICON_LABEL,
  HELP_LINK_TEXT,
  hintOf,
  INVALID_TIMEOUT_PARAMETER_MESSAGE,
  isFailingNotice,
  isSkippedReport,
  methodColor,
  operationUrl,
  PARTIAL_TEXT,
  PASSED_TEXT,
  reportBadge,
  reportHeadline,
  reportStatus,
  resolvePartial,
  resolveTestMode,
  resolveTimeout,
  sidebarStatus,
  SKIP_HEADLINE,
  statusColor,
  statusLabel,
  statusText,
  testModeText,
  timeoutMessage,
  truncateBody,
  widgetRow,
} from '../dist/report.js';
import { classify, sendValidation, serializePair, unreadableMessage } from '../dist/validation.js';

test('options default to the local Mokapi dashboard and validation off', () => {
  assert.deepEqual(resolveOptions(), { dashboardUrl: 'http://localhost:8080', defaultValidation: false, defaultTest: 'warning', defaultPartial: false, defaultTimeout: 4000 });
  assert.deepEqual(resolveOptions({}), resolveOptions());
});

test('options keep the given values and strip trailing slashes from the dashboard URL', () => {
  assert.deepEqual(
    resolveOptions({ dashboardUrl: 'https://mokapi.example.com/', defaultValidation: true }),
    { dashboardUrl: 'https://mokapi.example.com', defaultValidation: true, defaultTest: 'warning', defaultPartial: false, defaultTimeout: 4000 },
  );
});

test('options accept the test modes error, warning and off and reject anything else', () => {
  for (const defaultTest of ['error', 'warning', 'off']) assert.equal(resolveOptions({ defaultTest }).defaultTest, defaultTest);
  // `todo` was the name of `warning` before.
  for (const defaultTest of ['strict', 'todo', '', true, null]) {
    assert.throws(() => resolveOptions({ defaultTest }), /^Error: Mokapi: defaultTest must be 'error', 'warning' or 'off'\.$/);
  }
});

test('options accept a boolean defaultPartial and reject anything else', () => {
  for (const defaultPartial of [true, false]) assert.equal(resolveOptions({ defaultPartial }).defaultPartial, defaultPartial);
  for (const defaultPartial of ['yes', 1, null, 'true']) {
    assert.throws(() => resolveOptions({ defaultPartial }), /^Error: Mokapi: defaultPartial must be true or false\.$/);
  }
});

test('options accept a positive finite defaultTimeout and reject anything else', () => {
  for (const defaultTimeout of [1, 1500, 0.5, 60000]) assert.equal(resolveOptions({ defaultTimeout }).defaultTimeout, defaultTimeout);
  for (const defaultTimeout of [0, -1, '4000', Number.NaN, Infinity, null]) {
    assert.throws(() => resolveOptions({ defaultTimeout }), /^Error: Mokapi: defaultTimeout must be a positive number\.$/);
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

// Answers of Mokapi 0.60.0 to a request with partialResponse: true, they echo the option.
const partialAnswers = {
  valid: { ...answers.valid, partialResponse: true },
  invalid: { ...answers.invalid, partialResponse: true },
  noOperation: { ...answers.noOperation, partialResponse: true },
  ambiguous: { ...answers.ambiguous, partialResponse: true },
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

test('serialization sends partialResponse only for a partial story', async () => {
  const pair = () => [new Request('http://localhost:6006/api/profile'), Response.json({ name: 'Rex' })];
  assert.equal((await serializePair(...pair(), 'Profile API', true)).partialResponse, true);
  assert.equal((await serializePair(...pair(), undefined, true)).partialResponse, true);
  for (const payload of [await serializePair(...pair(), 'Profile API', false), await serializePair(...pair(), 'Profile API'), await serializePair(...pair())]) {
    assert.equal('partialResponse' in payload, false);
  }
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

const partialUnsupported = "The Mokapi at http://localhost:8080 doesn't support partial responses and must be updated to 0.60.0.";

test('classification of a partial request accepts the answers that echo partialResponse', async () => {
  for (const answer of Object.values(partialAnswers)) {
    assert.equal('partialUnsupportedMessage' in await classify(dashboardUrl, Response.json(answer), true), false);
  }
  assert.deepEqual(await classify(dashboardUrl, Response.json(partialAnswers.valid), true), { status: 'valid', errors: [], operation: answers.valid.operation });
});

test('classification of a partial request flags a valid, an invalid and a not-in-contract answer without the echo', async () => {
  for (const [answer, status] of [[answers.valid, 'valid'], [answers.invalid, 'invalid'], [answers.noOperation, 'not-in-contract'], [answers.ambiguous, 'not-in-contract']]) {
    const outcome = await classify(dashboardUrl, Response.json(answer), true);
    assert.equal(outcome.status, status);
    assert.deepEqual(outcome.errors, answer.errors);
    assert.equal(outcome.partialUnsupportedMessage, partialUnsupported);
  }
  assert.equal((await classify(dashboardUrl, Response.json({ ...answers.valid, partialResponse: false }), true)).partialUnsupportedMessage, partialUnsupported);
});

test('classification of a request that did not ask for partial responses flags nothing', async () => {
  for (const answer of [answers.valid, answers.invalid, answers.noOperation, partialAnswers.valid]) {
    assert.equal('partialUnsupportedMessage' in await classify(dashboardUrl, Response.json(answer)), false);
    assert.equal('partialUnsupportedMessage' in await classify(dashboardUrl, Response.json(answer), false), false);
  }
});

test('classification of a partial request keeps the other outcomes as they are', async () => {
  assert.equal((await classify(dashboardUrl, new Response('Method Not Allowed', { status: 405 }), true)).status, 'endpoint-missing');
  assert.deepEqual(await classify(dashboardUrl, Response.json(answers.unknownApi, { status: 404 }), true), { status: 'config-error', message: "api 'Unknown API' not found" });
  assert.equal((await classify(dashboardUrl, new TypeError('Failed to fetch'), true)).status, 'unreachable');
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

test('sending posts the JSON payload as a CORS simple request that MSW passes through to the validate endpoint', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const payload = { request: { method: 'GET', url: '/api/profile' }, response: { statusCode: 200 } };
  const response = await sendValidation(dashboardUrl, payload);
  assert.equal(response.status, 200);
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'http://localhost:8080/api/services/http/validate');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'text/plain;charset=UTF-8', Accept: 'msw/passthrough' });
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

const storyContext = (worker, { id = 'profile--valid', validation = 'on', mokapi, test } = {}) => ({
  id,
  msw: worker,
  globals: { mokapiValidation: validation, ...(test !== undefined && { mokapiTest: test }) },
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

const hookOptions = (panel, defaultTest = 'warning', defaultPartial = false, defaultTimeout = 4000) => ({ emit: panel.emit, dashboardUrl, defaultTest, defaultPartial, defaultTimeout });

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
  validationHook(storyContext(worker, { id: 'a--default' }), hookOptions(panel, 'warning'));
  validationHook(storyContext(worker, { id: 'a--error', mokapi: { test: 'error' } }), hookOptions(panel, 'warning'));
  validationHook(storyContext(worker, { id: 'a--off', mokapi: { test: 'off' } }), hookOptions(panel, 'error'));
  validationHook(storyContext(worker, { id: 'a--invalid', mokapi: { test: 'strict' } }), hookOptions(panel, 'error'));
  validationHook(storyContext(undefined, { id: 'a--no-worker', mokapi: { test: 'error' } }), hookOptions(panel, 'warning'));
  const started = panel.actions.filter(({ type }) => type === 'render-started');
  assert.deepEqual(started.map(({ storyId, testMode }) => [storyId, testMode]), [
    ['a--default', 'warning'], ['a--error', 'error'], ['a--off', 'off'], ['a--invalid', 'error'], ['a--no-worker', 'error'],
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

test('hook announces partial responses while validating, from defaultPartial or the story parameter', () => {
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker, { id: 'a--default' }), hookOptions(panel, 'warning', true));
  validationHook(storyContext(worker, { id: 'a--off', mokapi: { partial: false } }), hookOptions(panel, 'warning', true));
  validationHook(storyContext(worker, { id: 'a--on', mokapi: { partial: true } }), hookOptions(panel));
  validationHook(storyContext(worker, { id: 'a--strict' }), hookOptions(panel));
  validationHook(storyContext(undefined, { id: 'a--no-worker', mokapi: { partial: true } }), hookOptions(panel));
  const started = panel.actions.filter(({ type }) => type === 'render-started');
  assert.deepEqual(started.map(({ storyId, partial }) => [storyId, partial]), [
    ['a--default', true], ['a--off', undefined], ['a--on', true], ['a--strict', undefined], ['a--no-worker', true],
  ]);
  assert.equal('partial' in started[1], false);
});

test('hook announces no partial responses with validation off or for a disabled story', () => {
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker, { validation: 'off', mokapi: { partial: true } }), hookOptions(panel));
  validationHook(storyContext(worker, { mokapi: { disable: true, partial: true } }), hookOptions(panel, 'warning', true));
  assert.equal(panel.actions.length, 2);
  for (const action of panel.actions) assert.equal('partial' in action, false);
});

// An unjudged mount (disabled, or test mode 'off') tells the manager to forget the story's earlier Mokapi result.
const startedBy = (context, options) => {
  const panel = recorder();
  validationHook(context, options(panel));
  return panel.actions.filter(({ type }) => type === 'render-started');
};

test('hook marks the mount of a disabled story as unjudged with validation on and off, with and without a worker', () => {
  for (const validation of ['on', 'off']) {
    for (const worker of [fakeWorker(), undefined]) {
      const started = startedBy(storyContext(worker, { validation, mokapi: { disable: true } }), (panel) => hookOptions(panel));
      assert.equal(started.length, 1, `validation ${validation}, worker ${worker !== undefined}`);
      assert.equal(started[0].unjudged, true, `validation ${validation}, worker ${worker !== undefined}`);
    }
  }
});

test('hook marks the mount of a story with test mode off as unjudged, also when defaultTest or the fallback resolves to off', () => {
  const cases = [
    ['test: off', { test: 'off' }, 'warning'],
    ['defaultTest: off', undefined, 'off'],
    ['invalid test falling back to defaultTest: off', { test: 'strict' }, 'off'],
  ];
  for (const [name, mokapi, defaultTest] of cases) {
    for (const validation of ['on', 'off']) {
      for (const worker of [fakeWorker(), undefined]) {
        const started = startedBy(storyContext(worker, { validation, mokapi }), (panel) => hookOptions(panel, defaultTest));
        assert.equal(started.length, 1, `${name}, validation ${validation}, worker ${worker !== undefined}`);
        assert.equal(started[0].unjudged, true, `${name}, validation ${validation}, worker ${worker !== undefined}`);
      }
    }
  }
});

test('hook keeps the test mode off on the unjudged mount while validating', () => {
  const [started] = startedBy(storyContext(fakeWorker(), { mokapi: { test: 'off' } }), (panel) => hookOptions(panel));
  assert.equal(started.testMode, 'off');
  assert.equal(started.unjudged, true);
});

test('hook marks no mount of a judged story as unjudged', () => {
  for (const mokapi of [undefined, { test: 'warning' }, { test: 'error' }, { test: 'strict' }]) {
    for (const validation of ['on', 'off']) {
      for (const started of startedBy(storyContext(fakeWorker(), { validation, mokapi }), (panel) => hookOptions(panel, 'warning'))) {
        assert.equal('unjudged' in started, false, `${JSON.stringify(mokapi)}, validation ${validation}`);
      }
    }
  }
});

test('a re-render of an unjudged mount announces nothing again, a switch of the validation does', () => {
  const panel = recorder();
  const worker = fakeWorker();
  const mounted = testContext(worker, { mokapi: { test: 'off' } });
  validationHook(mounted, hookOptions(panel));
  validationHook({ ...mounted }, hookOptions(panel));
  assert.equal(panel.actions.length, 1);

  validationHook({ ...mounted, globals: { mokapiValidation: 'off' } }, hookOptions(panel));
  assert.deepEqual(panel.actions.map(({ type, unjudged }) => [type, unjudged]), [['render-started', true], ['render-started', true]]);
});

test('an invalid partial parameter shows a configuration notice while validating and the story uses defaultPartial', () => {
  const panel = recorder();
  const worker = fakeWorker();
  const notices = () => panel.actions.filter(({ type }) => type === 'notice').map(({ notice }) => [notice.kind, notice.message]);
  validationHook(storyContext(worker, { mokapi: { partial: 'yes' } }), hookOptions(panel, 'warning', true));
  assert.deepEqual(notices(), [['config-error', 'Mokapi: parameters.mokapi.partial must be true or false.']]);
  assert.equal(panel.actions[0].partial, true);
  validationHook(storyContext(worker, { mokapi: { partial: 'yes' } }), hookOptions(panel));
  assert.equal(panel.actions.filter(({ type }) => type === 'render-started')[1].partial, undefined);
  assert.equal(notices().length, 2);

  const quiet = recorder();
  validationHook(storyContext(worker, { validation: 'off', mokapi: { partial: 'yes' } }), hookOptions(quiet));
  assert.deepEqual(quiet.actions.filter(({ type }) => type === 'notice'), []);
});

test('an invalid partial parameter fails the story in mode error and warns in mode warning', async () => {
  for (const [mode, status] of [['error', 'failed'], ['warning', 'warning']]) {
    const panel = recorder();
    const context = testContext(fakeWorker(), { mokapi: { test: mode, partial: 'yes' } });
    validationHook(context, hookOptions(panel));
    await testHook(context, hookOptions(panel)).catch(() => {});
    assert.equal(context.reports[0].status, status);
    assert.equal(panel.actions.find(({ type }) => type === 'report').headline, 'Mokapi: parameters.mokapi.partial must be true or false.');
  }
});

test('listener sends partialResponse for a partial story only and shows the answer as a result without notice', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(partialAnswers.valid));
  for (const [mokapi, defaultPartial, expected] of [[{ partial: true }, false, true], [undefined, true, true], [{ partial: false }, true, undefined], [undefined, false, undefined]]) {
    fetch.mock.resetCalls();
    const panel = recorder();
    const worker = fakeWorker();
    validationHook(storyContext(worker, { mokapi }), hookOptions(panel, 'warning', defaultPartial));
    const result = panel.next();
    worker.mocked(getProfile(), jsonResponse());
    await result;
    await settled();
    assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).partialResponse, expected);
    assert.deepEqual(panel.actions.filter(({ type }) => type !== 'render-started').map(({ type }) => type), ['result']);
  }
});

test('listener shows the entry and one notice for every request when Mokapi does not echo partialResponse', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker, { mokapi: { partial: true } }), hookOptions(panel));
  worker.mocked(getProfile(), jsonResponse(), 'first');
  worker.mocked(getProfile(), jsonResponse(), 'second');
  await settled();
  await settled();
  const shown = panel.actions.reduce(reducePanel, initialPanelState);
  assert.deepEqual(shown.entries.map(({ status, errors }) => [status, errors]), [['invalid', answers.invalid.errors], ['invalid', answers.invalid.errors]]);
  assert.deepEqual(shown.notices, [{ kind: 'partial-unsupported', message: partialUnsupported }]);
  assert.equal(shown.partial, true);
});

test('a partial story with an old Mokapi fails in mode error and warns in mode warning, a strict story is not affected', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  for (const [mokapi, status] of [[{ test: 'error', partial: true }, 'failed'], [{ test: 'warning', partial: true }, 'warning'], [{ test: 'error', partial: false }, 'passed']]) {
    const panel = recorder();
    const worker = fakeWorker();
    const context = testContext(worker, { mokapi });
    validationHook(context, hookOptions(panel));
    worker.started(getProfile());
    const finished = testHook(context, hookOptions(panel));
    worker.mocked(getProfile(), jsonResponse());
    await finished.catch(() => {});
    assert.equal(context.reports[0].status, status);
    if (status !== 'passed') assert.equal(panel.actions.find(({ type }) => type === 'report').headline, partialUnsupported);
  }
});

test('a re-render keeps the partial responses of the mount and a remount resolves them again', () => {
  const panel = recorder();
  const worker = fakeWorker();
  const first = testContext(worker, { mokapi: { partial: true } });
  validationHook(first, hookOptions(panel));
  const rerender = { ...testContext(worker, { mokapi: { partial: true } }), abortSignal: first.abortSignal };
  validationHook(rerender, hookOptions(panel));
  assert.equal(panel.actions.filter(({ type }) => type === 'render-started').length, 1);
  validationHook(testContext(worker, { mokapi: { partial: false } }), hookOptions(panel));
  const started = panel.actions.filter(({ type }) => type === 'render-started');
  assert.deepEqual(started.map(({ partial }) => partial), [true, undefined]);
});

test('the report holds partial responses only for a partial story', async () => {
  for (const [mokapi, partial] of [[{ test: 'error', partial: true }, true], [{ test: 'error' }, undefined]]) {
    const context = testContext(fakeWorker(), { mokapi });
    validationHook(context, hookOptions(recorder()));
    await testHook(context, hookOptions(recorder()));
    assert.equal(context.reports[0].result.partial, partial);
    assert.equal('partial' in context.reports[0].result, partial === true);
  }
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
      request: { headers: {}, body: '', truncated: false },
      response: {
        headers: { 'content-type': 'application/json' },
        body: '{"name":"Jane Doe","email":"jane@example.com"}',
        truncated: false,
      },
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

test('listener puts request and response headers and bodies into valid and unreachable entries', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker), hookOptions(panel));
  const post = () => new Request('http://localhost:6006/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"name":"Jane"}',
  });
  const valid = panel.next();
  worker.mocked(post(), jsonResponse());
  const details = (await valid).entry;
  assert.equal(details.status, 'valid');
  assert.deepEqual(details.request, { headers: { 'content-type': 'application/json' }, body: '{"name":"Jane"}', truncated: false });
  assert.deepEqual(details.response, {
    headers: { 'content-type': 'application/json' },
    body: '{"name":"Jane Doe","email":"jane@example.com"}',
    truncated: false,
  });

  fetch.mock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
  const unreachable = panel.next();
  worker.mocked(post(), jsonResponse(), 'other');
  const { entry } = await unreachable;
  assert.equal(entry.status, 'unreachable');
  assert.equal(entry.request.body, '{"name":"Jane"}');
  assert.equal(entry.response.body, '{"name":"Jane Doe","email":"jane@example.com"}');
});

test('listener cuts a body over the limit in the entry and sends the full body to Mokapi', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker), hookOptions(panel));
  const body = 'x'.repeat(BODY_LIMIT + 1);
  const result = panel.next();
  worker.mocked(getProfile(), new Response(body));
  const { entry } = await result;
  assert.deepEqual(entry.response, { headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: 'x'.repeat(BODY_LIMIT), truncated: true });
  assert.equal(entry.request.truncated, false);
  assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).response.body, body);
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
const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stateOf = (entries = [], notices = []) => ({ ...initialPanelState, entries, notices });

test('the test mode of a story is its parameter, then the global, then defaultTest; invalid values fall back and are flagged', () => {
  const resolved = (mode, invalid = false, globalInvalid = false) => ({ mode, invalid, globalInvalid });
  assert.deepEqual(resolveTestMode(undefined, 'warning', 'warning'), resolved('warning'));
  assert.deepEqual(resolveTestMode(undefined, 'off', 'error'), resolved('off'));
  assert.deepEqual(resolveTestMode('error', 'warning', 'warning'), resolved('error'));
  assert.deepEqual(resolveTestMode('off', 'warning', 'error'), resolved('off'));
  assert.deepEqual(resolveTestMode('strict', 'warning', 'error'), resolved('warning', true));
  assert.deepEqual(resolveTestMode(true, 'off', 'error'), resolved('off', true));
  assert.deepEqual(resolveTestMode(undefined, 'strict', 'error'), resolved('error', false, true));
  assert.deepEqual(resolveTestMode('off', 'strict', 'error'), resolved('off', false, true));
  assert.deepEqual(resolveTestMode('todo', 'strict', 'error'), resolved('error', true, true));
  // A portable story without the preview annotation has no global: that counts as unset.
  assert.deepEqual(resolveTestMode(undefined, undefined, 'error'), resolved('error'));
});

test('the panel explains what each test mode does', () => {
  assert.equal(testModeText('error'), 'Test mode: error. Contract errors make this story fail.');
  assert.equal(testModeText('warning'), 'Test mode: warning. Contract errors are reported as warnings, the story stays green.');
  assert.equal(testModeText('off'), 'Test mode: off. Contract errors are shown here only.');
});

test('report status is failed in error mode and warning in warning mode for every failing result', () => {
  const failing = [
    stateOf([invalidEntry()]),
    stateOf([], [panelNotice('unreachable')]),
    stateOf([], [panelNotice('endpoint-missing')]),
    stateOf([], [panelNotice('config-error')]),
    stateOf([], [panelNotice('timeout')]),
  ];
  for (const state of failing) {
    assert.equal(reportStatus(state, 'error'), 'failed');
    assert.equal(reportStatus(state, 'warning'), 'warning');
  }
});

test('report status ignores results that are not in the contract, a missing worker and stories without requests', () => {
  for (const state of [
    initialPanelState,
    stateOf([validEntry(), notInContractEntry()]),
    stateOf([], [panelNotice('worker-missing')]),
  ]) {
    assert.equal(reportStatus(state, 'error'), 'passed');
    assert.equal(reportStatus(state, 'warning'), 'passed');
  }
});

const FAILED = 'Mokapi contract validation failed: ';
const requestLine = (id) => `GET /api/profile/${id} -> GET /profile/{id} (http://localhost:8080/dashboard/http/services/Profile%20API/profile/%7Bid%7D/get)`;

test('headline counts the invalid responses and uses the plural', () => {
  assert.equal(headline(stateOf([validEntry(), invalidEntry(), notInContractEntry()])), '1 response does not match the contract.');
  assert.equal(headline(stateOf([invalidEntry(), invalidEntry({ sequence: 2 })])), '2 responses do not match the contract.');
});

test('headline is the first failing notice when no response is invalid and empty when nothing fails', () => {
  const notices = [panelNotice('worker-missing'), panelNotice('unreachable', 'not reachable'), panelNotice('timeout', 'timeout (GET /a).')];
  assert.equal(headline(stateOf([validEntry()], notices)), 'not reachable');
  assert.equal(headline(stateOf([invalidEntry()], notices)), '1 response does not match the contract.');
  assert.equal(headline(stateOf([validEntry(), notInContractEntry()], [panelNotice('worker-missing')])), '');
  assert.equal(headline(initialPanelState), '');
});

test('error message names Mokapi and the count, then the request, the operation with its dashboard page and the errors', () => {
  assert.equal(errorMessage(stateOf([invalidEntry()])), [
    `${FAILED}1 response does not match the contract.`,
    '',
    requestLine(1),
    "  response.body: missing required property 'name'",
  ].join('\n'));
});

test('error message counts only invalid entries and uses the plural', () => {
  const second = invalidEntry({ sequence: 2, url: '/api/profile/2', errors: [
    { location: 'response.status', message: 'status 500 not defined' },
    { location: 'response.body', message: 'not valid' },
  ] });
  assert.equal(errorMessage(stateOf([validEntry(), invalidEntry(), notInContractEntry(), second])), [
    `${FAILED}2 responses do not match the contract.`,
    '',
    requestLine(1),
    "  response.body: missing required property 'name'",
    requestLine(2),
    '  response.status: status 500 not defined',
    '  response.body: not valid',
  ].join('\n'));
});

test('error message lists the failing notices after the invalid entries', () => {
  assert.equal(
    errorMessage(stateOf([invalidEntry()], [panelNotice('config-error', 'api not found')])).split('\n').at(-1),
    'api not found',
  );
});

test('error message of failing notices only starts with the first one and does not repeat it', () => {
  const notices = [panelNotice('worker-missing'), panelNotice('unreachable', 'not reachable'), panelNotice('timeout', 'timeout (GET /a).'), panelNotice('timeout', 'timeout (GET /b).')];
  assert.equal(errorMessage(stateOf([validEntry()], notices)), `${FAILED}not reachable\n\ntimeout (GET /a).\ntimeout (GET /b).`);
  assert.equal(errorMessage(stateOf([], [panelNotice('unreachable', 'not reachable')])), `${FAILED}not reachable`);
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

test('the partial parameter overrides defaultPartial', () => {
  for (const defaultPartial of [true, false]) {
    assert.deepEqual(resolvePartial(undefined, defaultPartial), { partial: defaultPartial, invalid: false });
    assert.deepEqual(resolvePartial(true, defaultPartial), { partial: true, invalid: false });
    assert.deepEqual(resolvePartial(false, defaultPartial), { partial: false, invalid: false });
  }
});

test('an invalid partial parameter falls back to defaultPartial and is flagged', () => {
  for (const parameter of ['yes', 'true', 1, 0, null, {}]) {
    assert.deepEqual(resolvePartial(parameter, true), { partial: true, invalid: true });
    assert.deepEqual(resolvePartial(parameter, false), { partial: false, invalid: true });
  }
});

test('the timeout parameter overrides defaultTimeout', () => {
  for (const defaultTimeout of [4000, 8000]) {
    assert.deepEqual(resolveTimeout(undefined, defaultTimeout), { timeout: defaultTimeout, invalid: false });
    assert.deepEqual(resolveTimeout(10000, defaultTimeout), { timeout: 10000, invalid: false });
    assert.deepEqual(resolveTimeout(0.5, defaultTimeout), { timeout: 0.5, invalid: false });
  }
});

test('an invalid timeout parameter falls back to defaultTimeout and is flagged', () => {
  assert.equal(INVALID_TIMEOUT_PARAMETER_MESSAGE, 'Mokapi: parameters.mokapi.timeout must be a positive number.');
  for (const parameter of ['long', '4000', 0, -1, Number.NaN, Infinity, null, {}]) {
    assert.deepEqual(resolveTimeout(parameter, 8000), { timeout: 8000, invalid: true });
  }
});

test('the timeout texts name the request, the limit in seconds and the options that raise it', () => {
  assert.equal(
    timeoutMessage('GET /api/profile', 4000),
    'Mokapi validation did not finish within 4 s (GET /api/profile). Increase parameters.mokapi.timeout or defaultTimeout.',
  );
  assert.equal(
    timeoutMessage('GET /api/profile', 1500),
    'Mokapi validation did not finish within 1.5 s (GET /api/profile). Increase parameters.mokapi.timeout or defaultTimeout.',
  );
  assert.equal(
    handlerTimeoutMessage('GET /api/profile', 4000),
    'No response from the MSW handler within 4 s (GET /api/profile), not validated. If the response is delayed on purpose, increase parameters.mokapi.timeout or defaultTimeout.',
  );
  assert.equal(
    handlerTimeoutMessage('GET /api/profile', 1500),
    'No response from the MSW handler within 1.5 s (GET /api/profile), not validated. If the response is delayed on purpose, increase parameters.mokapi.timeout or defaultTimeout.',
  );
});

test('every notice kind is failing except a missing worker and a handler timeout', () => {
  for (const kind of ['unreachable', 'endpoint-missing', 'config-error', 'timeout', 'partial-unsupported']) assert.equal(isFailingNotice(kind), true, kind);
  for (const kind of ['worker-missing', 'handler-timeout']) assert.equal(isFailingNotice(kind), false, kind);
});

test('a handler timeout alone passes the report and has no headline and no error message', () => {
  const state = stateOf([], [panelNotice('handler-timeout', 'no response (GET /a).')]);
  for (const mode of ['error', 'warning']) assert.equal(reportStatus(state, mode), 'passed');
  assert.equal(headline(state), '');
  const failing = stateOf([], [panelNotice('handler-timeout', 'no response (GET /a).'), panelNotice('timeout', 'timeout (GET /b).')]);
  assert.equal(headline(failing), 'timeout (GET /b).');
  assert.equal(errorMessage(failing), `${FAILED}timeout (GET /b).`);
});

test('the partial text says that missing properties are not checked', () => {
  assert.equal(PARTIAL_TEXT, 'Partial responses: missing properties are not checked.');
});

// What the report counted when it was made: `valid` decides between PASS and SKIP.
const passedReport = (valid) => ({ status: 'passed', headline: '', invalid: 0, valid });

test('badge says PARTIAL, green like PASS, for a passed partial story with a valid response', () => {
  const partial = { label: 'PARTIAL', status: 'positive' };
  for (const mode of ['error', 'warning']) {
    assert.deepEqual(reportBadge(mode, passedReport(1), true), partial);
    assert.deepEqual(reportBadge(mode, passedReport(2), true), partial);
  }
  assert.deepEqual(reportBadge('error', passedReport(1), false), { label: 'PASS', status: 'positive' });
});

test('badge of a partial story keeps WARN, FAIL, SKIP and WAIT and shows nothing in mode off', () => {
  assert.deepEqual(reportBadge('warning', { status: 'warning', headline: 'x', invalid: 1, valid: 0 }, true), { label: 'WARN', status: 'warning' });
  assert.deepEqual(reportBadge('error', { status: 'failed', headline: 'x', invalid: 1, valid: 0 }, true), { label: 'FAIL', status: 'negative' });
  assert.deepEqual(reportBadge('error', passedReport(0), true), { label: 'SKIP', status: 'mediumdark' });
  assert.deepEqual(reportBadge('error', undefined, true), { label: 'WAIT', status: 'mediumdark' });
  assert.equal(reportBadge('off', passedReport(1), true), undefined);
});

test('a partial-unsupported notice makes the report failing in mode error and a warning in mode warning', () => {
  const state = stateOf([validEntry()], [panelNotice('partial-unsupported', partialUnsupported)]);
  assert.equal(reportStatus(state, 'error'), 'failed');
  assert.equal(reportStatus(state, 'warning'), 'warning');
  assert.equal(headline(state), partialUnsupported);
  assert.match(errorMessage(state), new RegExp(`^Mokapi contract validation failed: ${escapeForRegExp(partialUnsupported)}`));
});

test('badge says WAIT until the report exists, in every mode but off', () => {
  for (const mode of ['error', 'warning']) assert.deepEqual(reportBadge(mode, undefined), { label: 'WAIT', status: 'mediumdark' });
  assert.equal(reportBadge('off', undefined), undefined);
  assert.equal(reportBadge('off', { status: 'warning', headline: 'ignored', invalid: 1, valid: 0 }), undefined);
  assert.equal(reportBadge(undefined, undefined), undefined);
  assert.equal(reportBadge(undefined, passedReport(1)), undefined);
});

test('badge maps the report status to PASS, WARN and FAIL', () => {
  assert.deepEqual(reportBadge('error', passedReport(1)), { label: 'PASS', status: 'positive' });
  assert.deepEqual(reportBadge('warning', { status: 'warning', headline: 'x', invalid: 1, valid: 0 }), { label: 'WARN', status: 'warning' });
  assert.deepEqual(reportBadge('error', { status: 'failed', headline: 'x', invalid: 1, valid: 0 }), { label: 'FAIL', status: 'negative' });
});

test('badge says SKIP when a passed report counted no valid response', () => {
  for (const mode of ['error', 'warning']) assert.deepEqual(reportBadge(mode, passedReport(0)), { label: 'SKIP', status: 'mediumdark' });
});

test('badge says PASS when the report counted a valid response, whatever else was not in the contract', () => {
  assert.deepEqual(reportBadge('error', passedReport(1)), { label: 'PASS', status: 'positive' });
});

test('badge keeps WARN and FAIL for a failing notice without a valid response', () => {
  assert.deepEqual(reportBadge('warning', { status: 'warning', headline: 'x', invalid: 0, valid: 0 }), { label: 'WARN', status: 'warning' });
  assert.deepEqual(reportBadge('error', { status: 'failed', headline: 'x', invalid: 0, valid: 0 }), { label: 'FAIL', status: 'negative' });
});

test('status color follows the status group, anything outside 100-599 is gray', () => {
  for (const code of [0, 99, 100, 199, 600, -1, NaN, 200.5]) assert.equal(statusColor(code), 'mediumdark', String(code));
  for (const code of [200, 299]) assert.equal(statusColor(code), 'positive', String(code));
  for (const code of [300, 399]) assert.equal(statusColor(code), 'secondary', String(code));
  for (const code of [400, 499]) assert.equal(statusColor(code), 'warning', String(code));
  for (const code of [500, 599]) assert.equal(statusColor(code), 'negative', String(code));
});

test('status text comes from the table, then from the group name', () => {
  const known = {
    100: 'Continue', 200: 'OK', 301: 'Moved Permanently', 404: 'Not Found', 500: 'Internal Server Error',
    413: 'Content Too Large', 422: 'Unprocessable Content',
    418: "I'm a teapot", 425: 'Too Early', 429: 'Too Many Requests',
    431: 'Request Header Fields Too Large', 511: 'Network Authentication Required',
  };
  for (const [code, text] of Object.entries(known)) assert.equal(statusText(Number(code)), text, code);
  const groups = { 199: 'Informational', 299: 'Success', 399: 'Redirect', 451: 'Client error', 499: 'Client error', 599: 'Server error' };
  for (const [code, text] of Object.entries(groups)) assert.equal(statusText(Number(code)), text, code);
  for (const code of [0, 99, 600, -1, NaN]) assert.equal(statusText(code), undefined, String(code));
});

test('status label joins the code and its text, the bare code stays without one', () => {
  assert.equal(statusLabel(200), '200 OK');
  assert.equal(statusLabel(404), '404 Not Found');
  assert.equal(statusLabel(299), '299 Success');
  assert.equal(statusLabel(0), '0');
  assert.equal(statusLabel(600), '600');
});

test('method color follows the dashboard: GET and OPTIONS blue, POST green, PUT and PATCH orange, DELETE red, HEAD and TRACE gold', () => {
  const colors = {
    GET: 'secondary', OPTIONS: 'secondary', POST: 'positive', PUT: 'warning', PATCH: 'warning',
    DELETE: 'negative', HEAD: 'gold', TRACE: 'gold',
  };
  for (const [method, color] of Object.entries(colors)) assert.equal(methodColor(method), color, method);
});

test('method color ignores the case, because fetch keeps patch in lower case', () => {
  assert.equal(methodColor('get'), 'secondary');
  assert.equal(methodColor('patch'), 'warning');
  assert.equal(methodColor('Delete'), 'negative');
});

test('an unknown method is gray, also an empty one and a prototype key', () => {
  for (const method of ['PROPFIND', '', 'constructor']) assert.equal(methodColor(method), 'mediumdark', method);
});

test('time is formatted as HH:mm:ss in local time, whatever the locale', () => {
  const local = (...time) => new Date(2026, 0, 1, ...time).getTime();
  assert.equal(formatTime(local(0, 0, 0)), '00:00:00');
  assert.equal(formatTime(local(12, 0, 0)), '12:00:00');
  assert.equal(formatTime(local(0, 5, 9)), '00:05:09');
  assert.equal(formatTime(local(14, 5, 9)), '14:05:09');
  assert.equal(formatTime(local(1, 2, 3)), '01:02:03');
  assert.equal(formatTime(local(23, 59, 59)), '23:59:59');
  assert.equal(formatTime(local(9, 5, 9, 999)), '09:05:09');
});

test('report headline is the headline of the report for a warning and a failed report only', () => {
  const invalidHeadline = '1 response does not match the contract.';
  assert.equal(reportHeadline({ status: 'failed', headline: invalidHeadline, invalid: 1, valid: 0 }, stateOf([invalidEntry()])), invalidHeadline);
  assert.equal(reportHeadline({ status: 'warning', headline: invalidHeadline, invalid: 1, valid: 0 }, stateOf([invalidEntry()])), invalidHeadline);
  assert.equal(reportHeadline({ status: 'warning', headline: 'not reachable', invalid: 0, valid: 0 }, stateOf([])), 'not reachable');
  assert.equal(reportHeadline(passedReport(1), stateOf([validEntry()])), undefined);
  assert.equal(reportHeadline(passedReport(1), stateOf([validEntry(), notInContractEntry()])), undefined);
  assert.equal(reportHeadline(undefined, stateOf([])), undefined);
});

test('report headline is the short headline of the notice kind that the report headline names', () => {
  const cases = [
    ['unreachable', 'Mokapi is not reachable.'],
    ['endpoint-missing', 'Mokapi needs an update.'],
    ['partial-unsupported', 'Mokapi needs an update.'],
    ['config-error', 'Invalid Mokapi configuration.'],
    ['timeout', 'Mokapi validation timed out.'],
  ];
  for (const [kind, short] of cases) {
    const message = `full ${kind} message with its hint`;
    const state = stateOf([], [panelNotice(kind, message)]);
    assert.equal(reportHeadline({ status: 'warning', headline: message, invalid: 0, valid: 0 }, state), short, kind);
    assert.equal(reportHeadline({ status: 'failed', headline: message, invalid: 0, valid: 0 }, state), short, kind);
  }
});

test('report headline is the short headline of the first failing notice when several fail', () => {
  const notices = [panelNotice('worker-missing', 'no worker'), panelNotice('unreachable', 'not reachable'), panelNotice('timeout', 'timeout (GET /a).')];
  assert.equal(reportHeadline({ status: 'failed', headline: 'not reachable', invalid: 0, valid: 0 }, stateOf([], notices)), 'Mokapi is not reachable.');
  const reversed = [notices[2], notices[1]];
  assert.equal(reportHeadline({ status: 'failed', headline: 'timeout (GET /a).', invalid: 0, valid: 0 }, stateOf([], reversed)), 'Mokapi validation timed out.');
});

test('report headline keeps the count headline of invalid responses next to a failing notice', () => {
  const invalidHeadline = '1 response does not match the contract.';
  const state = stateOf([invalidEntry()], [panelNotice('unreachable', 'not reachable')]);
  assert.equal(reportHeadline({ status: 'failed', headline: invalidHeadline, invalid: 1, valid: 0 }, state), invalidHeadline);
});

test('report headline keeps the full text of a test run result without notices', () => {
  const description = `${CONTRACT_ERROR_PREFIX}Mokapi is not reachable at http://localhost:8080. Check the dashboardUrl option.`;
  const run = testRunOf([componentTest('a--one', 'status-value:error', description)]);
  const panel = panelOf(initialPanelState, testRunResults(run), 'a--one');
  assert.deepEqual(panel.notices, []);
  assert.equal(reportHeadline(panel.report, panel), 'Mokapi is not reachable at http://localhost:8080. Check the dashboardUrl option.');
});

test('report headline says that no response was checked for a passed report without a valid response', () => {
  assert.equal(SKIP_HEADLINE, 'No response was checked against the contract.');
  assert.equal(reportHeadline(passedReport(0), stateOf([])), SKIP_HEADLINE);
  assert.equal(reportHeadline(passedReport(0), stateOf([notInContractEntry()])), SKIP_HEADLINE);
});

test('report headline is the short headline of the missing MSW worker for a skipped report', () => {
  const short = 'MSW worker not found.';
  const message = 'MSW worker not found: `context.msw` is missing. Use `mswLoader` or set `context.msw` in your loader.';
  const skipped = passedReport(0);
  assert.equal(reportHeadline(skipped, stateOf([], [panelNotice('worker-missing', message)])), short);
  assert.equal(reportHeadline(skipped, stateOf([notInContractEntry()], [panelNotice('worker-missing', message)])), short);
  // A response that came after the report doesn't change the headline.
  assert.equal(reportHeadline(skipped, stateOf([validEntry()], [panelNotice('worker-missing', message)])), short);
  assert.equal(reportHeadline(passedReport(1), stateOf([validEntry()], [panelNotice('worker-missing', message)])), undefined);
});

test('report headline is the short headline of the handler that did not answer for a skipped report, the first matching notice wins', () => {
  const short = 'No response from the MSW handler.';
  const noAnswer = handlerTimeoutMessage('GET /api/profile', 4000);
  const skipped = passedReport(0);
  assert.equal(reportHeadline(skipped, stateOf([], [panelNotice('handler-timeout', noAnswer)])), short);
  assert.equal(reportHeadline(skipped, stateOf([], [panelNotice('worker-missing', 'no worker'), panelNotice('handler-timeout', noAnswer)])), 'MSW worker not found.');
  assert.equal(reportHeadline(skipped, stateOf([], [panelNotice('handler-timeout', noAnswer), panelNotice('worker-missing', 'no worker')])), short);
  assert.equal(reportHeadline(passedReport(1), stateOf([validEntry()], [panelNotice('handler-timeout', noAnswer)])), undefined);
});

test('a body is cut after 10,000 characters and flagged only when something was cut', () => {
  assert.equal(BODY_LIMIT, 10_000);
  const atLimit = 'a'.repeat(BODY_LIMIT);
  assert.deepEqual(truncateBody(atLimit), { body: atLimit, truncated: false });
  assert.deepEqual(truncateBody(`${atLimit}b`), { body: atLimit, truncated: true });
  assert.deepEqual(truncateBody(''), { body: '', truncated: false });
});

test('a body is shown pretty-printed as JSON, as text otherwise and as (empty) without content', () => {
  assert.equal(formatBody('{"name":"Jane","tags":["a"]}'), '{\n  "name": "Jane",\n  "tags": [\n    "a"\n  ]\n}');
  assert.equal(formatBody('{"name":'), '{"name":');
  assert.equal(formatBody('plain text'), 'plain text');
  assert.equal(formatBody(''), '(empty)');
});

test('sidebar status is an error for a failed and a warning for a warning report, titled Mokapi', () => {
  const headline = '1 response does not match the contract.';
  const base = { typeId: 'mokapi/validation', storyId: 'a--one', title: 'Mokapi', description: headline, sidebarContextMenu: false };
  assert.deepEqual(sidebarStatus('a--one', { status: 'failed', headline, invalid: 1 }), { ...base, value: 'status-value:error', data: { invalid: 1 } });
  assert.deepEqual(sidebarStatus('a--one', { status: 'warning', headline, invalid: 1 }), { ...base, value: 'status-value:warning', data: { invalid: 1 } });
});

test('sidebar status stays out of the context menu status links, the test provider region shows Mokapi', () => {
  const headline = '1 response does not match the contract.';
  for (const status of ['failed', 'warning']) {
    assert.equal(sidebarStatus('a--one', { status, headline, invalid: 0 }).sidebarContextMenu, false, status);
  }
});

test('sidebar status carries the number of invalid responses of the report, so the context menu needs no panel state', () => {
  const headline = '2 responses do not match the contract.';
  assert.deepEqual(sidebarStatus('a--one', { status: 'failed', headline, invalid: 2 }).data, { invalid: 2 });
  assert.deepEqual(sidebarStatus('a--one', { status: 'warning', headline, invalid: 1 }).data, { invalid: 1 });
  assert.deepEqual(sidebarStatus('a--one', { status: 'failed', headline: 'not reachable', invalid: 0 }).data, { invalid: 0 });
});

test('sidebar status is a success for a passed report with a valid response', () => {
  assert.deepEqual(sidebarStatus('a--one', { status: 'passed', headline: '', invalid: 0, valid: 2 }), {
    typeId: 'mokapi/validation',
    storyId: 'a--one',
    title: 'Mokapi',
    value: 'status-value:success',
    description: PASSED_TEXT,
    data: { invalid: 0 },
    sidebarContextMenu: false,
  });
  assert.equal(PASSED_TEXT, 'All responses match the contract.');
});

test('sidebar status is none for a skipped report, a passed report without a valid response and without a report', () => {
  assert.equal(sidebarStatus('a--one', { status: 'passed', headline: '', invalid: 0, valid: 0 }), undefined);
  assert.equal(sidebarStatus('a--one', undefined), undefined);
});

test('the sidebar status of a passed report without a valid count is none', () => {
  const report = { status: 'passed', headline: '', invalid: 0 };
  assert.equal(sidebarStatus('a--one', report), undefined, 'missing');
  for (const valid of ['1', NaN, -1, 1.5, null]) {
    assert.equal(sidebarStatus('a--one', { ...report, valid }), undefined, String(valid));
  }
});

test('sidebar status of a failed or warning report is not a success, whatever the valid responses', () => {
  const headline = '1 response does not match the contract.';
  assert.equal(sidebarStatus('a--one', { status: 'failed', headline, invalid: 1, valid: 3 }).value, 'status-value:error');
  assert.equal(sidebarStatus('a--one', { status: 'warning', headline, invalid: 1, valid: 3 }).value, 'status-value:warning');
});

const mokapiStatus = (value, invalid, storyId = 'a--one') => ({ typeId: 'mokapi/validation', storyId, title: 'Mokapi', value, description: 'headline', ...(invalid !== undefined && { data: { invalid } }) });
const statusesOf = (...statuses) => Object.fromEntries(statuses.map((status) => [status.storyId, { [status.typeId]: status }]));
const story = { type: 'story', id: 'a--one' };
const rowOf = (status, entry = story) => contextMenuRow(entry, [entry.id], statusesOf(status));
const component = { type: 'component', id: 'a' };
const NO_RESULT_ROW = { value: 'status-value:unknown', label: 'Mokapi: No result', tooltip: 'Validate with Mokapi or run tests to see results', invalid: 0 };

test('context menu row is none for a docs entry, whatever the status map holds', () => {
  assert.equal(contextMenuRow({ type: 'docs', id: 'a--docs' }, ['a--one'], statusesOf(mokapiStatus('status-value:error'))), undefined);
  assert.equal(contextMenuRow({ type: 'docs', id: 'a--one' }, ['a--one'], statusesOf(mokapiStatus('status-value:success'))), undefined);
});

test('context menu row is gray without a result for a story without a Mokapi status', () => {
  assert.deepEqual(contextMenuRow(story, ['a--one'], {}), NO_RESULT_ROW);
  assert.deepEqual(contextMenuRow(story, ['a--one'], statusesOf(mokapiStatus('status-value:error', 1, 'b--two'))), NO_RESULT_ROW);
});

test('context menu row is gray without a result for a story with statuses of other types only', () => {
  const other = { ...mokapiStatus('status-value:error'), typeId: 'storybook/component-test' };
  assert.deepEqual(contextMenuRow(story, ['a--one'], statusesOf(other)), NO_RESULT_ROW);
});

test('context menu row is gray without a result for a pending or unknown Mokapi status', () => {
  for (const value of ['status-value:pending', 'status-value:unknown', 'status-value:made-up']) {
    assert.deepEqual(rowOf(mokapiStatus(value)), NO_RESULT_ROW, value);
  }
});

test('context menu row is green for a passed story and opens it', () => {
  assert.deepEqual(rowOf(mokapiStatus('status-value:success')), {
    value: 'status-value:success', label: 'Mokapi: Passed', tooltip: PASSED_TEXT, invalid: 0, target: 'a--one',
  });
});

test('context menu row is an error row for a story with an error status and a warning row for a warning status', () => {
  assert.deepEqual(rowOf(mokapiStatus('status-value:error')), {
    value: 'status-value:error', label: 'Mokapi: Error', tooltip: 'headline', invalid: 0, target: 'a--one',
  });
  assert.deepEqual(rowOf(mokapiStatus('status-value:warning')), {
    value: 'status-value:warning', label: 'Mokapi: Warning', tooltip: 'headline', invalid: 0, target: 'a--one',
  });
});

test('context menu row carries the number of invalid responses and names it in the label', () => {
  assert.deepEqual(rowOf(mokapiStatus('status-value:error', 1)), {
    value: 'status-value:error', label: 'Mokapi: Error (1 invalid response)', tooltip: 'headline', invalid: 1, target: 'a--one',
  });
  assert.equal(rowOf(mokapiStatus('status-value:error', 3)).label, 'Mokapi: Error (3 invalid responses)');
  assert.equal(rowOf(mokapiStatus('status-value:warning', 2)).label, 'Mokapi: Warning (2 invalid responses)');
  assert.equal(rowOf(mokapiStatus('status-value:error', 2)).invalid, 2);
});

test('context menu row counts no invalid responses when the status data holds no count, as the store is shared', () => {
  assert.equal(rowOf(mokapiStatus('status-value:error')).invalid, 0);
  assert.equal(rowOf(mokapiStatus('status-value:error')).label, 'Mokapi: Error');
  for (const invalid of ['x', -1, 1.5, NaN, null, undefined]) {
    const row = rowOf({ ...mokapiStatus('status-value:error'), data: { invalid } });
    assert.deepEqual([row.invalid, row.label], [0, 'Mokapi: Error'], String(invalid));
  }
  assert.equal(rowOf({ ...mokapiStatus('status-value:error'), data: 'x' }).invalid, 0);
  assert.equal(rowOf({ ...mokapiStatus('status-value:error'), data: null }).invalid, 0);
});

test('context menu row of a story has the headline as tooltip and a fixed text when the status has none', () => {
  assert.equal(rowOf({ ...mokapiStatus('status-value:error'), description: '2 responses do not match the contract.' }).tooltip, '2 responses do not match the contract.');
  assert.equal(rowOf({ ...mokapiStatus('status-value:error'), description: undefined }).tooltip, 'Contract validation failed');
  assert.equal(rowOf({ ...mokapiStatus('status-value:warning'), description: '' }).tooltip, 'Contract validation has warnings');
});

test('context menu row of a component without stories or without results is gray without a result', () => {
  assert.deepEqual(contextMenuRow(component, [], {}), NO_RESULT_ROW);
  assert.deepEqual(contextMenuRow(component, ['a--one', 'a--two'], {}), NO_RESULT_ROW);
  assert.deepEqual(contextMenuRow({ type: 'group', id: 'g' }, ['a--one'], statusesOf(mokapiStatus('status-value:pending'))), NO_RESULT_ROW);
});

test('context menu row of a component shows the worst status of its stories', () => {
  const leaves = ['a--one', 'a--two', 'a--three'];
  const rowFor = (...values) => contextMenuRow(component, leaves, statusesOf(...values.map((value, index) => mokapiStatus(value, undefined, leaves[index]))));
  assert.equal(rowFor('status-value:success', 'status-value:warning').value, 'status-value:warning');
  assert.equal(rowFor('status-value:error', 'status-value:warning', 'status-value:success').value, 'status-value:error');
  assert.equal(rowFor('status-value:success', 'status-value:success').value, 'status-value:success');
  assert.equal(rowFor('status-value:success', 'status-value:pending').label, 'Mokapi: Passed');
});

test('context menu row of a component sums the invalid responses of its error and warning stories', () => {
  const leaves = ['a--one', 'a--two', 'a--three', 'a--four'];
  const statuses = statusesOf(
    mokapiStatus('status-value:error', 1, 'a--one'),
    mokapiStatus('status-value:warning', 2, 'a--two'),
    mokapiStatus('status-value:success', 5, 'a--three'),
  );
  const row = contextMenuRow(component, leaves, statuses);
  assert.equal(row.invalid, 3);
  assert.equal(row.label, 'Mokapi: Error (3 invalid responses)');
  const warnings = contextMenuRow(component, leaves, statusesOf(mokapiStatus('status-value:warning', 1, 'a--one'), mokapiStatus('status-value:success', undefined, 'a--two')));
  assert.equal(warnings.label, 'Mokapi: Warning (1 invalid response)');
});

test('context menu row of a component has a fixed tooltip, not the headline of one story', () => {
  const error = contextMenuRow(component, ['a--one'], statusesOf(mokapiStatus('status-value:error', 1)));
  assert.equal(error.tooltip, 'Contract validation failed');
  const warning = contextMenuRow(component, ['a--one'], statusesOf(mokapiStatus('status-value:warning', 1)));
  assert.equal(warning.tooltip, 'Contract validation has warnings');
  assert.equal(contextMenuRow(component, ['a--one'], statusesOf(mokapiStatus('status-value:success'))).tooltip, PASSED_TEXT);
  assert.equal(contextMenuRow(component, ['a--one'], {}).tooltip, 'Validate with Mokapi or run tests to see results');
});

test('context menu row of a component opens the first error story, else the first warning, else the first passed one', () => {
  const leaves = ['a--three', 'a--one', 'a--two', 'a--four'];
  const targetOf = (...statuses) => contextMenuRow(component, leaves, statusesOf(...statuses)).target;
  assert.equal(targetOf(mokapiStatus('status-value:success', 0, 'a--three'), mokapiStatus('status-value:error', 1, 'a--two'), mokapiStatus('status-value:error', 1, 'a--four'), mokapiStatus('status-value:warning', 1, 'a--one')), 'a--two');
  assert.equal(targetOf(mokapiStatus('status-value:success', 0, 'a--three'), mokapiStatus('status-value:warning', 1, 'a--four'), mokapiStatus('status-value:warning', 1, 'a--two')), 'a--two');
  assert.equal(targetOf(mokapiStatus('status-value:success', 0, 'a--two'), mokapiStatus('status-value:success', 0, 'a--four')), 'a--two');
  assert.equal('target' in contextMenuRow(component, leaves, {}), false);
});

test('context menu row of a component ignores stories without a status', () => {
  const row = contextMenuRow(component, ['a--none', 'a--two'], statusesOf(mokapiStatus('status-value:warning', 1, 'a--two')));
  assert.equal(row.target, 'a--two');
  assert.equal(row.label, 'Mokapi: Warning (1 invalid response)');
});

test('widget row is gray without a result for no stories and for an empty status map', () => {
  assert.deepEqual(widgetRow([], {}), NO_RESULT_ROW);
  assert.deepEqual(widgetRow(['a--one', 'b--two'], {}), NO_RESULT_ROW);
  assert.equal('target' in widgetRow(['a--one'], {}), false);
});

test('widget row shows the worst status over all stories and sums their invalid responses', () => {
  const ids = ['a--one', 'b--two', 'c--three'];
  const rowFor = (...statuses) => widgetRow(ids, statusesOf(...statuses));
  assert.equal(rowFor(mokapiStatus('status-value:success', 0, 'a--one'), mokapiStatus('status-value:warning', 1, 'b--two')).value, 'status-value:warning');
  const error = rowFor(mokapiStatus('status-value:error', 1, 'a--one'), mokapiStatus('status-value:warning', 2, 'b--two'), mokapiStatus('status-value:success', 5, 'c--three'));
  assert.equal(error.value, 'status-value:error');
  assert.equal(error.invalid, 3);
  assert.equal(error.label, 'Mokapi: Error (3 invalid responses)');
});

test('widget row has fixed tooltips, also for a single failing story', () => {
  const tooltipOf = (value) => widgetRow(['a--one'], statusesOf(mokapiStatus(value, 1))).tooltip;
  assert.equal(tooltipOf('status-value:error'), 'Contract validation failed');
  assert.equal(tooltipOf('status-value:warning'), 'Contract validation has warnings');
  assert.equal(tooltipOf('status-value:success'), PASSED_TEXT);
  assert.equal(widgetRow([], {}).tooltip, 'Validate with Mokapi or run tests to see results');
});

test('widget row opens the first story of the winning status in the given order', () => {
  const ids = ['a--three', 'a--one', 'a--two', 'a--four'];
  const targetOf = (...statuses) => widgetRow(ids, statusesOf(...statuses)).target;
  // the status map is filled in another order than the story ids
  assert.equal(targetOf(mokapiStatus('status-value:error', 1, 'a--four'), mokapiStatus('status-value:error', 1, 'a--two'), mokapiStatus('status-value:warning', 1, 'a--three')), 'a--two');
  assert.equal(targetOf(mokapiStatus('status-value:success', 0, 'a--four'), mokapiStatus('status-value:warning', 1, 'a--two'), mokapiStatus('status-value:warning', 1, 'a--one')), 'a--one');
  assert.equal(targetOf(mokapiStatus('status-value:success', 0, 'a--two'), mokapiStatus('status-value:success', 0, 'a--three')), 'a--three');
});

test('widget row ignores stories without a status and statuses of other types', () => {
  const other = { ...mokapiStatus('status-value:error', 4, 'a--one'), typeId: 'storybook/component-test' };
  const row = widgetRow(['a--none', 'a--one', 'a--two'], statusesOf(other, mokapiStatus('status-value:warning', 1, 'a--two')));
  assert.equal(row.target, 'a--two');
  assert.equal(row.label, 'Mokapi: Warning (1 invalid response)');
  assert.equal(row.invalid, 1);
});

test('contract checkbox tooltip says whether test runs check contracts', () => {
  assert.equal(contractCheckboxTooltip(true), 'Contract validation runs with the tests (defaultValidation is on).');
  assert.equal(contractCheckboxTooltip(false), 'Contract validation is off in test runs. Set defaultValidation: true to check contracts.');
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
// addon-vitest runs the stories in Vitest's browser mode, where Vitest sets this global. Only there afterEach throws.
const underVitest = (t) => {
  globalThis.__vitest_browser__ = true;
  t.after(() => { delete globalThis.__vitest_browser__; });
};

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

const invalidHeadline = '1 response does not match the contract.';
const invalidMessage = [
  `Mokapi contract validation failed: ${invalidHeadline}`,
  '',
  'GET /api/profile?id=1 -> GET /profile (http://localhost:8080/dashboard/http/services/Profile%20API/profile/get)',
  '  response.body: required properties are missing: email',
].join('\n');

// Runs afterEach for one invalid response of a story with the given parameters.
async function runInvalidStory(t, mokapi) {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker, { mokapi });
  validationHook(context, hookOptions(panel));
  worker.started(getProfile());
  const finished = testHook(context, hookOptions(panel));
  worker.mocked(getProfile(), jsonResponse());
  return { panel, context, finished };
}

test('afterEach in error mode adds a failed report and sends it to the panel', async (t) => {
  const { panel, context, finished } = await runInvalidStory(t, { test: 'error' });
  await finished;
  assert.equal(context.reports[0].status, 'failed');
  const { renderId } = panel.actions[0];
  assert.deepEqual(panel.actions.at(-1), { type: 'report', renderId, storyId: 'profile--valid', status: 'failed', headline: invalidHeadline, invalid: 1, valid: 0 });
});

test('the report action names the number of invalid responses, so the manager needs no panel state for the sidebar row', async (t) => {
  const { panel, finished } = await runInvalidStory(t, { test: 'warning' });
  await finished;
  assert.equal(panel.actions.at(-1).invalid, 1);
});

test('the report action names the number of valid responses, so the sidebar tells a passed story from a skipped one', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker);
  validationHook(context, hookOptions(panel));
  worker.started(getProfile());
  const finished = testHook(context, hookOptions(panel));
  worker.mocked(getProfile(), jsonResponse());
  await finished;
  assert.equal(panel.actions.at(-1).status, 'passed');
  assert.equal(panel.actions.at(-1).valid, 1);
});

test('afterEach in error mode throws the message of the invalid responses under Vitest', async (t) => {
  underVitest(t);
  const { panel, context, finished } = await runInvalidStory(t, { test: 'error' });
  await assert.rejects(finished, { message: invalidMessage });
  assert.equal(context.reports[0].status, 'failed');
  assert.equal(panel.actions.at(-1).type, 'report');
});

test('afterEach throws a MokapiContractError whose name and stack show the Mokapi message', async (t) => {
  underVitest(t);
  const { finished } = await runInvalidStory(t, { test: 'error' });
  const error = await finished.then(() => undefined, (thrown) => thrown);
  assert.ok(error instanceof MokapiContractError);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'MokapiContractError');
  // Vitest prints the stack, so its first line has to carry the name too.
  assert.match(error.stack, /^MokapiContractError: Mokapi contract validation failed: /);
});

test('the report holds the test mode of the story, so the badge of a test run result shows its tooltip', async (t) => {
  for (const test of ['error', 'warning']) {
    const { context, finished } = await runInvalidStory(t, { test });
    await finished.catch(() => {});
    assert.equal(context.reports[0].result.testMode, test);
  }
});

test('afterEach in warning mode sends a warning report and passes the story, also under Vitest', async (t) => {
  underVitest(t);
  const { panel, context, finished } = await runInvalidStory(t, { test: 'warning' });
  await finished;
  assert.equal(context.reports[0].status, 'warning');
  assert.deepEqual(panel.actions.at(-1), { type: 'report', renderId: panel.actions[0].renderId, storyId: 'profile--valid', status: 'warning', headline: invalidHeadline, invalid: 1, valid: 0 });
});

test('afterEach sends a passed report with an empty headline', async () => {
  const panel = recorder();
  const context = testContext(fakeWorker(), failingMode);
  validationHook(context, hookOptions(panel));
  await testHook(context, hookOptions(panel));
  assert.deepEqual(panel.actions.at(-1), { type: 'report', renderId: panel.actions[0].renderId, storyId: 'profile--valid', status: 'passed', headline: '', invalid: 0, valid: 0 });
});

test('afterEach sends no report in off mode, with validation off or for a disabled story', async () => {
  for (const options of [{ validation: 'off', mokapi: { test: 'error' } }, { mokapi: { disable: true, test: 'error' } }, { mokapi: { test: 'off' } }]) {
    const panel = recorder();
    const context = testContext(fakeWorker(), options);
    validationHook(context, hookOptions(panel));
    await testHook(context, hookOptions(panel));
    assert.equal(panel.actions.some(({ type }) => type === 'report'), false);
  }
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
  assert.deepEqual(panel.actions.map(({ type }) => type), ['render-started', 'report']);
});

test('a mocked network error (HttpResponse.error()) is not sent to Mokapi and shows no notice', async (t) => {
  // Mokapi answers 400 for the status 0 of a network error, which would show as a misleading config error.
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('status code must be between 100 and 599', { status: 400 }));
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(panel));
  worker.started(getProfile(), 'network-error');
  const finished = testHook(context, hookOptions(panel));
  worker.mocked(getProfile(), Response.error(), 'network-error');
  await finished;
  await settled();
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(context.reports[0].status, 'passed');
  assert.deepEqual(panel.actions.map(({ type }) => type), ['render-started', 'report']);
});

test('a network error does not stop the next mocked response of the render from being validated', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(panel));
  worker.started(getProfile(), 'network-error');
  worker.started(new Request('http://localhost:6006/api/orders'), 'orders');
  const finished = testHook(context, hookOptions(panel));
  worker.mocked(getProfile(), Response.error(), 'network-error');
  worker.mocked(new Request('http://localhost:6006/api/orders'), jsonResponse(), 'orders');
  await finished;
  await settled();
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(context.reports[0].result.entries.length, 1);
});

// Mokapi never answers: the response was mocked, the validation stays open.
const holdMokapi = (t) => t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
const timeoutText = (path, seconds = 4) => `Mokapi validation did not finish within ${seconds} s (GET ${path}). Increase parameters.mokapi.timeout or defaultTimeout.`;
const handlerTimeoutText = (path, seconds = 4) => `No response from the MSW handler within ${seconds} s (GET ${path}), not validated. If the response is delayed on purpose, increase parameters.mokapi.timeout or defaultTimeout.`;

test('a validation that does not finish within 4 s fails with one notice per request', async (t) => {
  underVitest(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  holdMokapi(t);
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(panel));
  worker.started(getProfile(), 'one');
  worker.started(new Request('http://localhost:6006/api/orders'), 'two');
  worker.mocked(getProfile(), jsonResponse(), 'one');
  worker.mocked(new Request('http://localhost:6006/api/orders'), jsonResponse(), 'two');
  const finished = testHook(context, hookOptions(panel));
  t.mock.timers.tick(3999);
  assert.deepEqual(panel.actions.map(({ type }) => type), ['render-started']);
  t.mock.timers.tick(1);
  await assert.rejects(finished, {
    message: [
      `Mokapi contract validation failed: ${timeoutText('/api/profile?id=1')}`,
      '',
      timeoutText('/api/orders'),
    ].join('\n'),
  });
  assert.deepEqual(panel.actions.slice(1, 3).map(({ notice }) => notice.kind), ['timeout', 'timeout']);
  assert.equal(panel.actions[3].type, 'report');
  assert.equal(context.reports[0].status, 'failed');
  assert.equal(context.reports[0].result.notices.length, 2);
});

test('a request whose handler never answered ends as a handler timeout: nothing was validated, the story is skipped and stays green', async (t) => {
  underVitest(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(panel));
  worker.started(getProfile());
  const finished = testHook(context, hookOptions(panel));
  t.mock.timers.tick(4000);
  assert.equal(await finished, undefined);
  assert.deepEqual(panel.actions.slice(1).map(({ type, notice }) => notice?.kind ?? type), ['handler-timeout', 'report']);
  assert.equal(panel.actions[1].notice.message, handlerTimeoutText('/api/profile?id=1'));
  assert.deepEqual(panel.actions.at(-1), { type: 'report', renderId: panel.actions[0].renderId, storyId: 'profile--valid', status: 'passed', headline: '', invalid: 0, valid: 0 });
  assert.equal(context.reports.length, 1);
  assert.equal(context.reports[0].status, 'passed');
  assert.deepEqual(context.reports[0].result.notices.map(({ kind }) => kind), ['handler-timeout']);
  assert.equal(sidebarStatus('profile--valid', panel.actions.at(-1)), undefined);
});

test('a response that MSW delivered and Mokapi did not judge in time is a failing timeout, one that MSW did not deliver is a handler timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  holdMokapi(t);
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(recorder()));
  worker.started(getProfile(), 'mocked');
  worker.started(requestTo('/api/orders'), 'silent');
  worker.mocked(getProfile(), jsonResponse(), 'mocked');
  const finished = testHook(context, hookOptions(recorder()));
  t.mock.timers.tick(4000);
  await finished;
  assert.deepEqual(context.reports[0].result.notices, [
    { kind: 'timeout', message: timeoutText('/api/profile?id=1') },
    { kind: 'handler-timeout', message: handlerTimeoutText('/api/orders') },
  ]);
  assert.equal(context.reports[0].status, 'failed');
});

test('a story with one valid response and one that never comes passes with the valid entry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(panel));
  worker.started(getProfile(), 'answered');
  worker.started(requestTo('/api/orders'), 'silent');
  worker.mocked(getProfile(), jsonResponse(), 'answered');
  const finished = testHook(context, hookOptions(panel));
  // The quiet window ends and Mokapi judges the answered response before the limit is reached.
  await tick(t, 100);
  await tick(t, 3900);
  await finished;
  assert.equal(context.reports[0].status, 'passed');
  assert.deepEqual(context.reports[0].result.entries.map(({ status }) => status), ['valid']);
  assert.deepEqual(context.reports[0].result.notices.map(({ kind }) => kind), ['handler-timeout']);
  assert.equal(panel.actions.at(-1).valid, 1);
});

test('the limit is defaultTimeout, and the notice names it in seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker);
  validationHook(context, hookOptions(panel, 'warning', false, 1500));
  worker.started(getProfile());
  const finished = testHook(context, hookOptions(panel, 'warning', false, 1500));
  t.mock.timers.tick(1499);
  assert.equal(context.reports.length, 0);
  t.mock.timers.tick(1);
  await finished;
  assert.equal(context.reports[0].result.notices[0].message, handlerTimeoutText('/api/profile?id=1', 1.5));
});

test('parameters.mokapi.timeout overrides defaultTimeout for its story only', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = fakeWorker();
  const long = testContext(worker, { mokapi: { timeout: 10000 } });
  const short = testContext(worker);
  validationHook(long, hookOptions(recorder()));
  worker.started(getProfile());
  const longFinished = testHook(long, hookOptions(recorder()));
  t.mock.timers.tick(9999);
  assert.equal(long.reports.length, 0);
  t.mock.timers.tick(1);
  await longFinished;
  assert.equal(long.reports[0].result.notices[0].message, handlerTimeoutText('/api/profile?id=1', 10));

  validationHook(short, hookOptions(recorder()));
  worker.started(getProfile(), 'second');
  const shortFinished = testHook(short, hookOptions(recorder()));
  t.mock.timers.tick(4000);
  await shortFinished;
  assert.equal(short.reports[0].result.notices[0].message, handlerTimeoutText('/api/profile?id=1', 4));
});

test('an invalid timeout parameter shows a configuration notice while validating and the story uses defaultTimeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker, { mokapi: { timeout: 'long' } });
  validationHook(context, hookOptions(panel, 'warning', false, 1500));
  assert.deepEqual(panel.actions.slice(1).map(({ notice }) => notice), [
    { kind: 'config-error', message: 'Mokapi: parameters.mokapi.timeout must be a positive number.' },
  ]);
  worker.started(getProfile());
  const finished = testHook(context, hookOptions(panel, 'warning', false, 1500));
  t.mock.timers.tick(1500);
  await finished;
  assert.equal(context.reports[0].result.notices.at(-1).message, handlerTimeoutText('/api/profile?id=1', 1.5));
  assert.equal(context.reports[0].status, 'warning');

  const quiet = recorder();
  validationHook(testContext(worker, { validation: 'off', mokapi: { timeout: 'long' } }), hookOptions(quiet));
  assert.equal(quiet.actions.some(({ type }) => type === 'notice'), false);
});

test('a custom limit counts from the start of afterEach, the quiet window included', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = fakeWorker();
  const context = testContext(worker, { mokapi: { timeout: 1500 } });
  validationHook(context, hookOptions(recorder()));
  const finished = testHook(context, hookOptions(recorder()));
  await tick(t, 50);
  worker.started(getProfile(), 'early');
  await tick(t, 1449);
  assert.equal(context.reports.length, 0);
  await tick(t, 1);
  await finished;
  assert.equal(context.reports[0].result.notices[0].message, handlerTimeoutText('/api/profile?id=1', 1.5));
});

test('a response after the report shows up in the panel, the report and its counts stay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker);
  validationHook(context, hookOptions(panel));
  worker.started(getProfile());
  const finished = testHook(context, hookOptions(panel));
  t.mock.timers.tick(4000);
  await finished;
  const report = panel.actions.at(-1);
  assert.equal(report.valid, 0);
  worker.mocked(getProfile(), jsonResponse());
  await settled();
  assert.equal(panel.actions.at(-1).type, 'result');
  assert.equal(context.reports.length, 1);
  assert.deepEqual(context.reports[0].result.entries, []);
  assert.equal(panel.actions.filter(({ type }) => type === 'report').length, 1);
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
  underVitest(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  holdMokapi(t);
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(recorder()));
  const finished = testHook(context, hookOptions(recorder()));
  for (let i = 0; i < 11; i++) {
    await tick(t, 90);
    worker.started(requestTo(`/api/stream${i}`), `stream${i}`);
    worker.mocked(requestTo(`/api/stream${i}`), jsonResponse(), `stream${i}`);
  }
  await tick(t, 10);
  worker.started(requestTo('/api/after'), 'after');
  await tick(t, 2999);
  t.mock.timers.tick(1);
  const lines = await finished.then(() => [], (error) => error.message.split('\n'));
  assert.equal(lines.length, 12);
  assert.ok(lines.filter((line) => line !== '').every((line) => /did not finish within 4 s \(GET \/api\/stream\d+\)\. Increase parameters\.mokapi\.timeout or defaultTimeout\.$/.test(line)), lines.join('\n'));
});

test('a request that starts in the quiet window times out 4 s after afterEach began', async (t) => {
  underVitest(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  holdMokapi(t);
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(recorder()));
  let settledAt;
  const finished = testHook(context, hookOptions(recorder())).catch(() => { settledAt = 'rejected'; });
  await tick(t, 50);
  worker.started(getProfile(), 'early');
  worker.mocked(getProfile(), jsonResponse(), 'early');
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

// Timers that were created and neither fired (the tests tick less than the shortest one) nor cleared.
function trackPendingTimers(t) {
  const pending = new Set();
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args) => { const timer = set(...args); pending.add(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', (timer) => { pending.delete(timer); clear(timer); });
  return pending;
}

test('a story torn down during the quiet window leaves no timer running', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = trackPendingTimers(t);
  const context = testContext(fakeWorker(), failingMode);
  validationHook(context, hookOptions(recorder()));
  const finished = testHook(context, hookOptions(recorder()));
  await tick(t, 50);
  context.abort();
  await finished;
  assert.equal(pending.size, 0, 'the quiet window and its 1 s limit are cleared');
});

test('a request that starts after the story was torn down does not start a timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(recorder()));
  const finished = testHook(context, hookOptions(recorder()));
  await tick(t, 50);
  context.abort();
  await finished;
  const pending = trackPendingTimers(t);
  worker.started(getProfile(), 'after-teardown');
  assert.equal(pending.size, 0);
});

test('afterEach of a story that is already torn down starts no timer and reports nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = fakeWorker();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(recorder()));
  context.abort();
  const pending = trackPendingTimers(t);
  assert.equal(await testHook(context, hookOptions(recorder())), undefined);
  worker.started(getProfile(), 'after-teardown');
  assert.equal(pending.size, 0);
  assert.deepEqual(context.reports, []);
});

// A re-render (globals or args changed) runs the hooks again with a new context but the same abortSignal.
const reRender = (context) => ({ ...testContext(context.msw), abortSignal: context.abortSignal });

test('a request that starts while two re-renders wait extends the quiet window of both', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const worker = fakeWorker();
  const first = testContext(worker);
  const second = reRender(first);
  validationHook(first, hookOptions(recorder()));
  const firstFinished = testHook(first, hookOptions(recorder()));
  await tick(t, 50);
  validationHook(second, hookOptions(recorder()));
  const secondFinished = testHook(second, hookOptions(recorder()));
  await tick(t, 40);
  worker.started(getProfile(), 'during-window');
  worker.mocked(getProfile(), jsonResponse(), 'during-window');
  await tick(t, 50);
  assert.equal(first.reports.length, 0, 'the first run waits until 100 ms after the request that started at 90 ms');
  await tick(t, 50);
  await Promise.all([firstFinished, secondFinished]);
  assert.equal(first.reports.length, 1);
  assert.equal(second.reports.length, 1);
});

test('a re-render that finished does not take the request:start of the one still waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const worker = fakeWorker();
  const first = testContext(worker);
  const second = reRender(first);
  validationHook(first, hookOptions(recorder()));
  const firstFinished = testHook(first, hookOptions(recorder()));
  await tick(t, 50);
  validationHook(second, hookOptions(recorder()));
  const secondFinished = testHook(second, hookOptions(recorder()));
  await tick(t, 50);
  await firstFinished;
  await tick(t, 20);
  worker.started(getProfile(), 'after-first');
  worker.mocked(getProfile(), jsonResponse(), 'after-first');
  await tick(t, 99);
  assert.equal(second.reports.length, 0, 'the second run waits until 100 ms after the request that started at 120 ms');
  await tick(t, 1);
  await secondFinished;
  assert.equal(second.reports.length, 1);
});

test('a timeout does not stop a story in warning mode', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  holdMokapi(t);
  const worker = fakeWorker();
  const context = testContext(worker);
  validationHook(context, hookOptions(recorder()));
  worker.started(getProfile());
  worker.mocked(getProfile(), jsonResponse());
  const finished = testHook(context, hookOptions(recorder()));
  t.mock.timers.tick(4000);
  await finished;
  assert.equal(context.reports[0].status, 'warning');
});

test('afterEach returns without a report when the story is torn down while it waits', async () => {
  const worker = fakeWorker();
  const panel = recorder();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(panel));
  worker.started(getProfile());
  const finished = testHook(context, hookOptions(panel));
  context.abort();
  assert.equal(await finished, undefined);
  assert.deepEqual(context.reports, []);
  assert.deepEqual(panel.actions.map(({ type }) => type), ['render-started']);
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
  underVitest(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  const mounted = testContext(worker, failingMode);
  validationHook(mounted, hookOptions(panel));
  worker.started(getProfile(), 'mount');
  const finishedMount = testHook(mounted, hookOptions(panel));
  worker.mocked(getProfile(), jsonResponse(), 'mount');
  await assert.rejects(finishedMount, /^MokapiContractError: Mokapi contract validation failed: 1 response does not match the contract\./);

  const rerender = rerenderOf(mounted, worker, failingMode);
  validationHook(rerender, hookOptions(panel));
  await assert.rejects(testHook(rerender, hookOptions(panel)), /^MokapiContractError: Mokapi contract validation failed: 1 response does not match the contract\./);
  assert.equal(rerender.reports[0].status, 'failed');
});

test('a re-render sends its report with the render id of the mount', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  const mounted = testContext(worker, failingMode);
  validationHook(mounted, hookOptions(panel));
  const { renderId } = panel.actions[0];
  worker.started(getProfile(), 'mount');
  const finishedMount = testHook(mounted, hookOptions(panel));
  worker.mocked(getProfile(), jsonResponse(), 'mount');
  await finishedMount;

  const rerender = rerenderOf(mounted, worker, failingMode);
  validationHook(rerender, hookOptions(panel));
  await testHook(rerender, hookOptions(panel));
  const reports = panel.actions.filter(({ type }) => type === 'report');
  assert.deepEqual(reports.map((report) => [report.renderId, report.status]), [[renderId, 'failed'], [renderId, 'failed']]);
  assert.equal(panel.actions.reduce(reducePanel, initialPanelState).report.status, 'failed');
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

test('an invalid test parameter is a configuration error and the story uses defaultTest', async (t) => {
  underVitest(t);
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker, { mokapi: { test: 'strict' } });
  validationHook(context, hookOptions(panel, 'error'));
  assert.deepEqual(panel.actions.slice(1).map(({ type, notice }) => [type, notice.kind, notice.message]), [
    ['notice', 'config-error', "Mokapi: parameters.mokapi.test must be 'error', 'warning' or 'off'."],
  ]);
  await assert.rejects(testHook(context, hookOptions(panel, 'error')), /^MokapiContractError: Mokapi contract validation failed: Mokapi: parameters\.mokapi\.test must be 'error', 'warning' or 'off'\.$/);
  assert.equal(context.reports[0].status, 'failed');

  const warning = testContext(worker, { mokapi: { test: 'strict' } });
  validationHook(warning, hookOptions(panel, 'warning'));
  await testHook(warning, hookOptions(panel, 'warning'));
  assert.equal(warning.reports[0].status, 'warning');
});

const INVALID_TEST_GLOBAL = "Mokapi: global mokapiTest must be 'error', 'warning' or 'off'.";

// Runs beforeEach and afterEach of one invalid response and returns how the story ended.
async function runInvalidStoryWith(t, options, defaultTest) {
  underVitest(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.invalid));
  const panel = recorder();
  const worker = fakeWorker();
  const context = testContext(worker, options);
  validationHook(context, hookOptions(panel, defaultTest));
  worker.started(getProfile());
  const finished = testHook(context, hookOptions(panel, defaultTest));
  worker.mocked(getProfile(), jsonResponse());
  return { panel, context, finished };
}

test('the global mokapiTest replaces defaultTest for a story without a test parameter', async (t) => {
  const { context, finished } = await runInvalidStoryWith(t, { test: 'warning' }, 'error');
  await finished;
  assert.equal(context.reports[0].status, 'warning');
  assert.equal(context.reports[0].result.testMode, 'warning');
});

test('a test parameter wins over the global mokapiTest', async (t) => {
  const { context, finished } = await runInvalidStoryWith(t, { test: 'warning', mokapi: { test: 'error' } }, 'warning');
  await assert.rejects(finished, /^MokapiContractError: /);
  assert.equal(context.reports[0].status, 'failed');
});

test('an invalid test parameter falls back to the global mokapiTest and keeps its own notice', async (t) => {
  const { panel, context, finished } = await runInvalidStoryWith(t, { test: 'off', mokapi: { test: 'strict' } }, 'error');
  assert.equal(await finished, undefined);
  assert.deepEqual(context.reports, []);
  assert.equal(panel.actions[0].unjudged, true);
  assert.deepEqual(panel.actions.filter(({ type }) => type === 'notice').map(({ notice }) => [notice.kind, notice.message]), [
    ['config-error', "Mokapi: parameters.mokapi.test must be 'error', 'warning' or 'off'."],
  ]);
});

test('an invalid global mokapiTest is a configuration error and the story uses defaultTest', async (t) => {
  const { panel, context, finished } = await runInvalidStoryWith(t, { test: 'strict' }, 'error');
  assert.equal(panel.actions[0].testMode, 'error');
  assert.deepEqual(panel.actions.slice(1, 2).map(({ type, notice }) => [type, notice.kind, notice.message]), [['notice', 'config-error', INVALID_TEST_GLOBAL]]);
  await assert.rejects(finished, /^MokapiContractError: /);
  assert.equal(context.reports[0].status, 'failed');
});

test('an invalid global mokapiTest is reported for a story with a valid test parameter too', () => {
  const panel = recorder();
  validationHook(storyContext(fakeWorker(), { test: 'strict', mokapi: { test: 'off' } }), hookOptions(panel));
  assert.deepEqual(panel.actions.filter(({ type }) => type === 'notice').map(({ notice }) => notice.message), [INVALID_TEST_GLOBAL]);
});

test('an invalid global mokapiTest is not reported with validation off or for a disabled story', () => {
  for (const options of [{ validation: 'off' }, { mokapi: { disable: true } }]) {
    const panel = recorder();
    validationHook(storyContext(fakeWorker(), { ...options, test: 'strict' }), hookOptions(panel));
    assert.deepEqual(panel.actions.filter(({ type }) => type === 'notice'), []);
  }
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
  const workerPanel = recorder();
  validationHook(withoutWorker, hookOptions(workerPanel));
  await testHook(withoutWorker, hookOptions(workerPanel));
  assert.equal(withoutWorker.reports[0].status, 'passed');
  assert.equal(workerPanel.actions.at(-1).type, 'report');
  assert.equal(workerPanel.actions.at(-1).status, 'passed');

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
  assert.equal(panel.actions.at(-1).type, 'report');
  assert.equal(panel.actions.at(-1).status, 'passed');
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
  assert.deepEqual(panel.actions.map(({ type, unjudged }) => [type, unjudged]), [['render-started', true]]);
});

const entry = (sequence, status = 'valid') => ({
  sequence, time: 1000 + sequence, method: 'GET', url: '/api/profile', statusCode: 200, status, errors: [],
});
const renderStarted = (renderId, storyId = 'a--one') => ({ type: 'render-started', storyId, renderId });
const resultOf = (renderId, sequence, status, storyId = 'a--one') => ({ type: 'result', storyId, renderId, entry: entry(sequence, status) });
const noticeOf = (renderId, kind, message = kind, storyId = 'a--one') => ({ type: 'notice', storyId, renderId, notice: { kind, message } });
const reduceAll = (...actions) => actions.reduce(reducePanel, initialPanelState);

test('panel starts empty and a render of a story clears its entries and notices', () => {
  assert.deepEqual(initialPanelState, { renderId: 0, entries: [], notices: [] });
  const state = reduceAll(renderStarted(1), resultOf(1, 1), noticeOf(1, 'unreachable'), renderStarted(2));
  assert.deepEqual(state, { storyId: 'a--one', renderId: 2, entries: [], notices: [] });
});

test('a story is rendering from its started phase until its finished phase', () => {
  const started = nextRendering(initialRendering, { type: 'started', storyId: 'a--one' });
  assert.equal(isRendering(started, 'a--one'), true);
  assert.equal(isRendering(nextRendering(started, { type: 'finished', storyId: 'a--one' }), 'a--one'), false);
  assert.equal(isRendering(initialRendering, 'a--one'), false);
});

test('rendering is tracked per story', () => {
  const started = nextRendering(initialRendering, { type: 'started', storyId: 'a--one' });
  assert.equal(isRendering(started, 'a--two'), false);
  const bothStarted = nextRendering(started, { type: 'started', storyId: 'a--two' });
  const oneFinished = nextRendering(bothStarted, { type: 'finished', storyId: 'a--two' });
  assert.deepEqual([isRendering(oneFinished, 'a--one'), isRendering(oneFinished, 'a--two')], [true, false]);
});

test('a finished phase without a started phase and a repeated started phase do not break the tracking', () => {
  assert.equal(isRendering(nextRendering(initialRendering, { type: 'finished', storyId: 'a--one' }), 'a--one'), false);
  const twice = nextRendering(nextRendering(initialRendering, { type: 'started', storyId: 'a--one' }), { type: 'started', storyId: 'a--one' });
  assert.equal(isRendering(nextRendering(twice, { type: 'finished', storyId: 'a--one' }), 'a--one'), false);
});

test('panel keeps the request and response details of an entry', () => {
  const request = { headers: { accept: '*/*' }, body: '', truncated: false };
  const response = { headers: { 'content-type': 'application/json' }, body: '{"name":"Jane"}', truncated: false };
  const detailed = { ...entry(1), request, response };
  const state = reduceAll(renderStarted(1), { type: 'result', storyId: 'a--one', renderId: 1, entry: detailed });
  assert.deepEqual(state.entries[0].request, request);
  assert.deepEqual(state.entries[0].response, response);
});

test('panel keeps the test mode of the render and resets it with the next render', () => {
  const started = (renderId, testMode) => ({ ...renderStarted(renderId), ...(testMode && { testMode }) });
  assert.equal(reduceAll(started(1, 'error')).testMode, 'error');
  assert.equal(reduceAll(started(1, 'error'), resultOf(1, 1, 'invalid'), noticeOf(1, 'timeout')).testMode, 'error');
  assert.equal('testMode' in reduceAll(started(1, 'error'), started(2)), false);
  assert.equal('testMode' in initialPanelState, false);
});

const reportOf = (renderId, status = 'failed', headline = '1 response does not match the contract.', invalid = 1, valid = 0) => ({ type: 'report', renderId, storyId: 'a--one', status, headline, invalid, valid });

test('panel keeps the report of the current render and clears it with the next render', () => {
  const state = reduceAll(renderStarted(1), resultOf(1, 1, 'invalid'), reportOf(1));
  assert.deepEqual(state.report, { status: 'failed', headline: '1 response does not match the contract.', invalid: 1, valid: 0 });
  assert.equal(state.entries.length, 1);
  assert.equal(reduceAll(renderStarted(1), reportOf(1, 'passed', '', 0, 2)).report.valid, 2);
  assert.equal('report' in reduceAll(renderStarted(1), reportOf(1), renderStarted(2)), false);
  assert.equal('report' in initialPanelState, false);
});

test('panel ignores the report of an earlier render', () => {
  const state = reduceAll(renderStarted(1), renderStarted(2), reportOf(1));
  assert.equal('report' in state, false);
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

test('panel counts only valid entries as valid responses', () => {
  const state = reduceAll(
    renderStarted(1), resultOf(1, 1, 'valid'), resultOf(1, 2, 'invalid'),
    resultOf(1, 3, 'not-in-contract'), resultOf(1, 4, 'valid'), resultOf(1, 5, 'unreachable'),
  );
  assert.equal(validCount(state), 2);
  assert.equal(validCount(initialPanelState), 0);
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

test('preview starts with the values of defaultValidation and defaultTest and renders no Storybook dropdown', async () => {
  // Vite defines this constant at build time; defaultValidation true shows that it is read.
  globalThis.__MOKAPI_STORYBOOK_OPTIONS__ = { dashboardUrl: 'http://localhost:9090', defaultValidation: true };
  const { globalTypes, initialGlobals } = await import('../dist/preview.js');
  assert.deepEqual(initialGlobals, { mokapiValidation: 'on', mokapiTest: 'warning' });
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

test('preview registers an afterEach that fails a story with a contract error in error mode and warns in warning mode', async (t) => {
  underVitest(t);
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
  await assert.rejects(failing.finished, /^MokapiContractError: Mokapi contract validation failed: 1 response does not match the contract\./);
  assert.equal(failing.context.reports[0].status, 'failed');
  const warning = await run({});
  assert.equal(await warning.finished, undefined);
  assert.equal(warning.context.reports[0].status, 'warning');
});

// Storybook runs the project's afterEach hooks in reverse order of the annotation files, so the first one runs last.
test('preset puts the preview annotation before the existing ones and adds the manager entry after them', () => {
  assert.deepEqual(previewAnnotations(['a.js']).map((file) => file.split('/').at(-1)), ['preview.js', 'a.js']);
  assert.deepEqual(managerEntries().map((file) => file.split('/').at(-1)), ['manager.js']);
});

test('preset defines the resolved options for the preview and sets up no proxy', () => {
  const config = viteFinal({ server: { port: 6006 } }, { dashboardUrl: 'http://localhost:9090/', defaultValidation: true });
  assert.deepEqual(JSON.parse(config.define.__MOKAPI_STORYBOOK_OPTIONS__), {
    dashboardUrl: 'http://localhost:9090', defaultValidation: true, defaultTest: 'warning', defaultPartial: false, defaultTimeout: 4000,
  });
  assert.deepEqual(config.server, { port: 6006 });
  assert.equal(JSON.stringify(config).includes('proxy'), false);
  assert.deepEqual(JSON.parse(viteFinal({}).define.__MOKAPI_STORYBOOK_OPTIONS__), resolveOptions());
  assert.equal(JSON.parse(viteFinal({}, { defaultTimeout: 8000 }).define.__MOKAPI_STORYBOOK_OPTIONS__).defaultTimeout, 8000);
});

test('preset injects only the dashboard URL and defaultValidation into the manager and escapes markup', () => {
  const head = managerHead('<title>x</title>', { dashboardUrl: 'http://localhost:9090/' });
  assert.ok(head.startsWith('<title>x</title>\n<script>'));
  assert.ok(head.includes('globalThis.__MOKAPI_PANEL_OPTIONS__ = {"dashboardUrl":"http://localhost:9090","defaultValidation":false};'));
  assert.ok(managerHead('', { defaultValidation: true }).includes('{"dashboardUrl":"http://localhost:8080","defaultValidation":true};'));
  assert.throws(() => managerHead('', { defaultValidation: 'yes' }), /Mokapi: defaultValidation/);
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
  assert.deepEqual(Object.keys(packageJson.exports), ['.', './preset', './package.json']);
  const sources = await Promise.all(['listener', 'validation', 'results', 'preview', 'options', 'preset']
    .map((name) => readFile(new URL(`../dist/${name}.js`, import.meta.url), 'utf8')));
  assert.deepEqual(sources.filter((source) => /from ['"]msw/.test(source)), []);
});

test('root preset.js re-exports the built preset and is published, as the Storybook integration catalog requires', async () => {
  const [root, built, packageJson] = await Promise.all([
    import('../preset.js'),
    import('../dist/preset.js'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  assert.deepEqual(Object.keys(root), Object.keys(built));
  assert.equal(root.managerHead, built.managerHead);
  assert.ok(packageJson.files.includes('preset.js'));
});

test('React is no peer dependency, because the manager bundle gets it from Storybook', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.peerDependencies.react, undefined);
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
test('a second switch that is enqueued while the re-render runs remounts once after the latest re-render has finished', () => {
  const enqueued = [initialValidation('off'), started(), switched('on'), finished(), started(), switched('off')];
  assert.deepEqual(remountSteps(...enqueued, finished()), []);
  assert.deepEqual(remountSteps(...enqueued, finished(), started(), finished()), ['a--one']);
});

// Immediate, observed on Storybook 10.6.7 in the e2e scenario "switching validation twice while the old render is
// still finishing remounts once after the latest re-render": started(old), switched(on), started(re-render 1),
// switched(off), started(re-render 2), finished(old), finished(re-render 1), finished(re-render 2).
// Three renders are open, so the remount waits for the third finished (it used to fire at the second).
test('a second switch while the old render is still finishing remounts after the latest re-render has finished', () => {
  const immediate = [initialValidation('off'), started(), switched('on'), started(), switched('off'), started()];
  assert.deepEqual(remountSteps(...immediate, finished()), []);
  assert.deepEqual(remountSteps(...immediate, finished(), finished()), []);
  assert.deepEqual(remountSteps(...immediate, finished(), finished(), finished()), ['a--one']);
  assert.deepEqual(remountSteps(...immediate, finished(), finished(), finished(), finished()), ['a--one']);
});

test('three switches within one render remount once after the latest re-render has finished', () => {
  const threeSwitches = [
    initialValidation('off'), started(), switched('on'), started(), switched('off'), started(), switched('on'), started(),
  ];
  assert.deepEqual(remountSteps(...threeSwitches, finished(), finished(), finished()), []);
  assert.deepEqual(remountSteps(...threeSwitches, finished(), finished(), finished(), finished()), ['a--one']);
});

// Observed on Storybook 10.6.7 in the e2e scenario "switching validation twice, the second time after the old render
// has finished, remounts once after the latest re-render": started(old), switched(on), started(re-render 1),
// finished(old), switched(off), started(re-render 2), finished(re-render 1), finished(re-render 2).
// The old render has finished at the second switch, but re-render 1 still runs.
test('a second switch while the first re-render of a running render completes remounts after the latest re-render has finished', () => {
  const beforeFirstReRenderFinished = [
    initialValidation('off'), started(), switched('on'), started(), finished(), switched('off'), started(),
  ];
  assert.deepEqual(remountSteps(...beforeFirstReRenderFinished, finished()), []);
  assert.deepEqual(remountSteps(...beforeFirstReRenderFinished, finished(), finished()), ['a--one']);
});

// Guard: the second switch is enqueued, because re-render 1 still runs: started(old), switched(on),
// started(re-render 1), finished(old), switched(off), finished(re-render 1), started(re-render 2), finished.
test('a second switch that is enqueued behind the first re-render remounts after the latest re-render has finished', () => {
  const enqueued = [initialValidation('off'), started(), switched('on'), started(), finished(), switched('off'), finished()];
  assert.deepEqual(remountSteps(...enqueued), []);
  assert.deepEqual(remountSteps(...enqueued, started()), []);
  assert.deepEqual(remountSteps(...enqueued, started(), finished()), ['a--one']);
});

test('a switch after the previous re-render has remounted does not skip a finished', () => {
  const afterRemount = [initialValidation('off'), started(), switched('on'), started(), finished(), finished(), switched('off'), started()];
  assert.deepEqual(remountSteps(...afterRemount), ['a--one']);
  assert.deepEqual(remountSteps(...afterRemount, finished()), ['a--one', 'a--one']);
});

test('a re-render of another story that is running does not make the switch skip a finished', () => {
  const beforeFinished = [initialValidation('off'), switched('on', 'a--two'), started('a--two'), switched('off', 'a--one'), started()];
  assert.deepEqual(remountSteps(...beforeFinished, finished()), ['a--one']);
});

// The click on another story changes the manager's selection before its STORY_CHANGED arrives, so the
// remount of the old story is still pending then. Remounting it would render the old story next to the new one.
test('a remount is dropped when its story is no longer the selected one', () => {
  assert.equal(remountIfSelected('a--one', 'a--one'), 'a--one');
  assert.equal(remountIfSelected('a--one', 'a--two'), undefined);
  assert.equal(remountIfSelected(undefined, 'a--one'), undefined);
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

// The payload of addon-vitest's `test-run-completed` event (`CurrentRun`), reduced to what the addon reads.
const mokapiReport = (status, result = { entries: [invalidEntry()], notices: [], testMode: 'warning' }) => ({ type: 'mokapi', version: 1, status, result });
const componentTest = (storyId, value = 'status-value:success', description = '') => ({ storyId, typeId: 'storybook/component-test', value, title: 'Component tests', description });
const testRunOf = (statuses, reports = {}) => ({ componentTestStatuses: statuses, reports, storyIds: undefined });

// addon-vitest owns the payload and may change it: the manager reads it through `readTestRun`, which tells whether it
// has the shape the addon reads, so a listener on the channel never throws.
const malformedTestRuns = {
  'no payload': undefined,
  'null': null,
  'an empty object': {},
  'statuses that are no array': { componentTestStatuses: 'a--one', reports: {} },
  'no reports': { componentTestStatuses: [componentTest('a--one')] },
  'reports that are null': { componentTestStatuses: [componentTest('a--one')], reports: null },
  'a status without a story id': { componentTestStatuses: [{ typeId: 'storybook/component-test' }], reports: {} },
  'a status with a story id that is no string': { componentTestStatuses: [{ storyId: 1 }], reports: {} },
  'reports of a story that are no array': { componentTestStatuses: [componentTest('a--one')], reports: { 'a--one': {} } },
  'a status with a description that is no string': { componentTestStatuses: [{ storyId: 'a--one', description: 5 }], reports: {} },
  'a report that is null': { componentTestStatuses: [componentTest('a--one')], reports: { 'a--one': [null] } },
  'a status that is null': { componentTestStatuses: [null], reports: {} },
};

test('a test run payload that is not shaped as expected is not read', () => {
  for (const [name, payload] of Object.entries(malformedTestRuns)) {
    assert.equal(readTestRun(payload), undefined, name);
  }
});

test('a test run payload with the expected shape is read as it is', () => {
  const payload = testRunOf([componentTest('a--one')], { 'a--one': [mokapiReport('warning')] });
  assert.equal(readTestRun(payload), payload);
  const empty = testRunOf([]);
  assert.equal(readTestRun(empty), empty);
});

// The channel event itself is untrusted too: `readTestRunEvent` reads the run of a completed event and never throws.
test('a channel event that is no completed test run with a payload as expected is not read', () => {
  const valid = testRunOf([componentTest('a--one')]);
  const events = {
    'undefined': undefined,
    'null': null,
    'a string': 'test-run-completed',
    'a number': 1,
    'an object without a type': { payload: valid },
    'another event type': { type: 'test-run-started', payload: valid },
    'no payload': { type: 'test-run-completed' },
    'a malformed payload': { type: 'test-run-completed', payload: malformedTestRuns['no reports'] },
  };
  for (const [name, event] of Object.entries(events)) {
    assert.equal(readTestRunEvent(event), undefined, name);
  }
});

test('a completed test run event is read as the payload it carries', () => {
  const payload = testRunOf([componentTest('a--one')], { 'a--one': [mokapiReport('warning')] });
  assert.equal(readTestRunEvent({ type: 'test-run-completed', payload }), payload);
});

test('a test run result of a warning report keeps its entries, notices and test mode and has the headline of the entries', () => {
  const result = { entries: [invalidEntry()], notices: [panelNotice('timeout')], testMode: 'warning' };
  const run = testRunOf([componentTest('a--one')], { 'a--one': [mokapiReport('warning', result)] });
  assert.deepEqual(testRunResults(run), {
    'a--one': {
      report: { status: 'warning', headline: '1 response does not match the contract.', invalid: 1, valid: 0 },
      entries: result.entries,
      notices: result.notices,
      testMode: 'warning',
    },
  });
  assert.deepEqual(sidebarStatus('a--one', testRunResults(run)['a--one'].report), {
    typeId: 'mokapi/validation',
    storyId: 'a--one',
    title: 'Mokapi',
    description: '1 response does not match the contract.',
    value: 'status-value:warning',
    data: { invalid: 1 },
    sidebarContextMenu: false,
  });
});

test('a test run result of a partial story shows partial responses and its report stays passed', () => {
  const result = { entries: [validEntry()], notices: [], testMode: 'error', partial: true };
  const run = testRunOf([componentTest('a--one')], { 'a--one': [mokapiReport('passed', result)] });
  const runs = testRunResults(run);
  assert.equal(runs['a--one'].partial, true);
  assert.equal(runs['a--one'].report.status, 'passed');
  const panel = panelOf(initialPanelState, runs, 'a--one');
  assert.equal(panel.partial, true);
  assert.deepEqual(reportBadge(panel.testMode, panel.report, panel.partial), { label: 'PARTIAL', status: 'positive' });
});

test('a test run result of a strict story or with a non-true partial shows no partial responses', () => {
  for (const partial of [undefined, false, 'yes']) {
    const result = { entries: [validEntry()], notices: [], testMode: 'error', ...(partial !== undefined && { partial }) };
    const run = testRunOf([componentTest('a--one')], { 'a--one': [mokapiReport('passed', result)] });
    const runs = testRunResults(run);
    assert.equal('partial' in runs['a--one'], false);
    const panel = panelOf(initialPanelState, runs, 'a--one');
    assert.equal('partial' in panel, false);
    assert.deepEqual(reportBadge(panel.testMode, panel.report, panel.partial), { label: 'PASS', status: 'positive' });
  }
});

test('a test run result carries the number of invalid responses in its report', () => {
  const result = { entries: [invalidEntry(), invalidEntry()], notices: [], testMode: 'warning' };
  const run = testRunOf([componentTest('a--one')], { 'a--one': [mokapiReport('warning', result)] });
  assert.deepEqual(sidebarStatus('a--one', testRunResults(run)['a--one'].report).data, { invalid: 2 });
});

test('a test run result of a failed report is failed', () => {
  const result = { entries: [], notices: [panelNotice('unreachable', 'not reachable')], testMode: 'error' };
  const run = testRunOf([componentTest('a--one')], { 'a--one': [mokapiReport('failed', result)] });
  assert.deepEqual(testRunResults(run)['a--one'].report, { status: 'failed', headline: 'not reachable', invalid: 0, valid: 0 });
});

test('a test run result of a passed report with a valid response counts the valid responses and has the success status', () => {
  const result = { entries: [validEntry(), notInContractEntry(), validEntry()], notices: [], testMode: 'warning' };
  const run = testRunOf([componentTest('a--one')], { 'a--one': [mokapiReport('passed', result)] });
  assert.deepEqual(testRunResults(run), {
    'a--one': {
      report: { status: 'passed', headline: '', invalid: 0, valid: 2 },
      entries: result.entries,
      notices: [],
      testMode: 'warning',
    },
  });
  assert.equal(sidebarStatus('a--one', testRunResults(run)['a--one'].report).value, 'status-value:success');
});

test('stories that ran without a Mokapi report or with a skipped one took part in the run but have no result', () => {
  const run = testRunOf(
    [componentTest('a--empty'), componentTest('a--not-in-contract'), componentTest('a--none'), componentTest('a--other')],
    {
      'a--empty': [mokapiReport('passed', { entries: [], notices: [], testMode: 'error' })],
      'a--not-in-contract': [mokapiReport('passed', { entries: [notInContractEntry()], notices: [], testMode: 'warning' })],
      'a--other': [{ type: 'a11y', version: 1, status: 'warning', result: {} }],
    },
  );
  assert.deepEqual(ranStoryIds(run), ['a--empty', 'a--not-in-contract', 'a--none', 'a--other']);
  assert.deepEqual(testRunResults(run), {});
});

test('a failed story without report gets a failed result with the headline of the Mokapi error text and no entries', () => {
  const description = [
    'Mokapi contract validation failed: 1 response does not match the contract.',
    '',
    'GET /api/profile -> GET /api/profile (http://localhost:8080/dashboard/...)',
    '    at <anonymous> (story.tsx:1:1)',
  ].join('\n');
  const run = testRunOf([componentTest('a--one', 'status-value:error', description)]);
  assert.deepEqual(testRunResults(run), {
    'a--one': { report: { status: 'failed', headline: '1 response does not match the contract.', invalid: 0, valid: 0 }, entries: [], notices: [], testMode: 'error' },
  });
});

test('a failed story with another error has no result', () => {
  const run = testRunOf([componentTest('a--one', 'status-value:error', 'AssertionError: expected 1 to be 2')]);
  assert.deepEqual(testRunResults(run), {});
  assert.deepEqual(ranStoryIds(run), ['a--one']);
});

test('reports of another type or version and malformed results are ignored', () => {
  const bad = (report) => testRunResults(testRunOf([componentTest('a--one')], { 'a--one': [report] }));
  assert.deepEqual(bad({ ...mokapiReport('warning'), version: 2 }), {});
  assert.deepEqual(bad({ ...mokapiReport('warning'), type: 'a11y' }), {});
  assert.deepEqual(bad({ type: 'mokapi', version: 1, status: 'warning', result: { entries: 'x', notices: [] } }), {});
  assert.deepEqual(bad({ type: 'mokapi', version: 1, status: 'warning', result: { entries: [] } }), {});
  assert.deepEqual(bad({ type: 'mokapi', version: 1, status: 'warning', result: null }), {});
  assert.deepEqual(bad({ type: 'mokapi', version: 1, status: 'unknown', result: { entries: [], notices: [] } }), {});
});

test('a result without a known test mode has none', () => {
  const run = testRunOf([componentTest('a--one')], { 'a--one': [mokapiReport('warning', { entries: [invalidEntry()], notices: [], testMode: 'strict' })] });
  assert.equal('testMode' in testRunResults(run)['a--one'], false);
});

test('a test run replaces the results of the stories that ran and keeps the others', () => {
  const warned = { report: { status: 'warning', headline: 'h' }, entries: [], notices: [], testMode: 'warning' };
  const before = { 'a--ran': warned, 'a--ran-passed': warned, 'a--outside': warned };
  const run = testRunOf(
    [componentTest('a--ran'), componentTest('a--ran-passed'), componentTest('a--new')],
    { 'a--ran': [mokapiReport('failed', { entries: [], notices: [panelNotice('timeout', 'slow')], testMode: 'error' })], 'a--new': [mokapiReport('warning')] },
  );
  const after = applyTestRun(before, run);
  assert.deepEqual(Object.keys(after).sort(), ['a--new', 'a--outside', 'a--ran']);
  assert.equal(after['a--ran'].report.headline, 'slow');
  assert.equal(after['a--outside'], warned);
  assert.deepEqual(Object.keys(before), ['a--ran', 'a--ran-passed', 'a--outside']);
});

test('a passed run result replaces an older warning of the story and a skipped one removes it', () => {
  const warned = { report: { status: 'warning', headline: 'h', invalid: 1, valid: 0 }, entries: [], notices: [], testMode: 'warning' };
  const before = { 'a--passed': warned, 'a--skipped': warned };
  const run = testRunOf(
    [componentTest('a--passed'), componentTest('a--skipped')],
    {
      'a--passed': [mokapiReport('passed', { entries: [validEntry()], notices: [], testMode: 'warning' })],
      'a--skipped': [mokapiReport('passed', { entries: [], notices: [], testMode: 'warning' })],
    },
  );
  const after = applyTestRun(before, run);
  assert.deepEqual(Object.keys(after), ['a--passed']);
  assert.equal(after['a--passed'].report.status, 'passed');
});

test('a story forgets its test run result, the other results stay', () => {
  const result = { report: { status: 'warning', headline: 'h' }, entries: [], notices: [] };
  const runs = { 'a--one': result, 'a--two': result };
  assert.deepEqual(forgetStoryRun(runs, 'a--one'), { 'a--two': result });
  assert.equal(forgetStoryRun(runs, 'a--three'), runs);
  assert.deepEqual(runs, { 'a--one': result, 'a--two': result });
});

test('the panel of a story shows its test run result, otherwise what the UI reported for it', () => {
  const entry = invalidEntry();
  const result = { report: { status: 'warning', headline: 'h' }, entries: [entry], notices: [panelNotice('timeout')], testMode: 'warning' };
  const ui = { ...stateOf([validEntry()]), storyId: 'a--one', renderId: 3 };
  assert.deepEqual(panelOf(ui, { 'a--one': result }, 'a--one'), {
    storyId: 'a--one', renderId: 0, entries: [entry], notices: result.notices, testMode: 'warning', report: result.report, fromTestRun: true,
  });
  assert.equal(panelOf(ui, { 'a--two': result }, 'a--one'), ui);
  assert.equal(panelOf(ui, {}, 'a--two'), initialPanelState);
  assert.equal('testMode' in panelOf(ui, { 'a--one': { ...result, testMode: undefined } }, 'a--one'), false);
  // A story id is no property of `Object`.
  assert.equal(panelOf(ui, {}, 'constructor'), initialPanelState);
});

// A report belongs to its mount. When the mount started before a run, its report is older than the run.
test('a run overtakes the report of a validating mount that has not reported yet', () => {
  const mounts = startValidatingMount({}, 'a--one');
  const overtaken = overtakeMounts(mounts, testRunOf([componentTest('a--one')]));
  assert.deepEqual(settleReport(overtaken, 'a--one'), { mounts: {}, overtaken: true });
  assert.deepEqual(mounts, { 'a--one': 'validating' });
});

test('a report without a run in between settles normally and ends the mount', () => {
  const mounts = startValidatingMount({}, 'a--one');
  assert.deepEqual(settleReport(mounts, 'a--one'), { mounts: {}, overtaken: false });
});

test('a report of a story that is not mounting, e.g. a re-render with changed args, is not overtaken', () => {
  const settled = settleReport({}, 'a--one').mounts;
  assert.deepEqual(settleReport(overtakeMounts(settled, testRunOf([componentTest('a--one')])), 'a--one'), { mounts: {}, overtaken: false });
  assert.deepEqual(settleReport({}, 'constructor'), { mounts: {}, overtaken: false });
});

test('a run marks only the stories that ran and are still mounting', () => {
  const mounts = startValidatingMount(startValidatingMount({}, 'a--one'), 'a--two');
  const marked = overtakeMounts(mounts, testRunOf([componentTest('a--one'), componentTest('a--other')]));
  assert.deepEqual(marked, { 'a--one': 'overtaken', 'a--two': 'validating' });
  assert.equal(overtakeMounts(mounts, testRunOf([componentTest('a--other')])), mounts);
});

test('a later run while the mount is still pending keeps the mark', () => {
  const run = testRunOf([componentTest('a--one')]);
  const twice = overtakeMounts(overtakeMounts(startValidatingMount({}, 'a--one'), run), run);
  assert.deepEqual(twice, { 'a--one': 'overtaken' });
});

test('a new validating mount forgets the mark of the older one', () => {
  const overtaken = overtakeMounts(startValidatingMount({}, 'a--one'), testRunOf([componentTest('a--one')]));
  const remounted = startValidatingMount(overtaken, 'a--one');
  assert.deepEqual(remounted, { 'a--one': 'validating' });
  assert.deepEqual(settleReport(remounted, 'a--one'), { mounts: {}, overtaken: false });
});

test('clearing the test runs lets the pending report count again', () => {
  const overtaken = overtakeMounts(startValidatingMount({}, 'a--one'), testRunOf([componentTest('a--one')]));
  const released = releaseOvertaken(overtaken);
  assert.deepEqual(released, { 'a--one': 'validating' });
  assert.deepEqual(settleReport(released, 'a--one'), { mounts: {}, overtaken: false });
});

// The hook contract: the listeners run inside MSW's emit and never throw, a problem is a panel notice.
// What a clone of a consumed or locked body does, e.g. `TypeError: Response body is already used`.
const unclonable = (message) => ({ clone() { throw new TypeError(message); } });
const unclonableResponse = () => Object.assign(jsonResponse(), unclonable('Response body is already used'));
const unclonableRequest = () => Object.assign(getProfile(), unclonable('Request body is already used'));
const readNotice = ({ actions }) => actions.find(({ type }) => type === 'notice');

test('listener does not throw out of the emit when the response cannot be cloned, and shows a notice', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker), hookOptions(panel));
  const { renderId } = panel.actions[0];
  assert.doesNotThrow(() => worker.mocked(getProfile(), unclonableResponse()));
  await settled();
  assert.equal(fetch.mock.callCount(), 0);
  const notice = readNotice(panel);
  assert.equal(notice?.renderId, renderId);
  assert.equal(notice?.notice.kind, 'config-error');
  assert.match(notice?.notice.message, /^Mokapi: could not read the mocked request or response: .*already used/);
});

test('listener does not throw out of the emit when the request cannot be cloned, and shows a notice', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker), hookOptions(panel));
  assert.doesNotThrow(() => worker.mocked(unclonableRequest(), jsonResponse()));
  await settled();
  assert.equal(readNotice(panel)?.notice.kind, 'config-error');
});

test('listener causes no unhandled rejection when showing a result throws, and still shows a notice', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  const panel = recorder();
  const emit = (action) => {
    panel.emit(action);
    if (action.type === 'result') throw new Error('channel closed');
  };
  const worker = fakeWorker();
  validationHook(storyContext(worker), { emit, dashboardUrl, defaultTest: 'warning' });
  worker.mocked(getProfile(), jsonResponse());
  await settled();
  await settled();
  assert.deepEqual(rejections, []);
  assert.match(readNotice(panel)?.notice.message ?? '', /could not read the mocked request or response: channel closed/);
});

test('afterEach does not wait for the timeout for a request whose pair could not be read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = fakeWorker();
  const panel = recorder();
  const context = testContext(worker, failingMode);
  validationHook(context, hookOptions(panel));
  worker.started(getProfile());
  try { worker.mocked(getProfile(), unclonableResponse()); } catch { /* the first test covers the throw */ }
  let finished = false;
  const done = testHook(context, hookOptions(panel)).catch(() => {}).then(() => { finished = true; });
  await tick(t, 100);
  await settled();
  assert.equal(finished, true, 'afterEach is still waiting for the 4 s timeout');
  await done;
  assert.equal(panel.actions.some(({ type, notice }) => type === 'notice' && notice.kind === 'timeout'), false);
  assert.equal(context.reports[0]?.status, 'failed');
});

test('the notice text names the message of an Error and the text of anything else that was thrown', () => {
  assert.equal(unreadableMessage(new Error('boom')), 'Mokapi: could not read the mocked request or response: boom');
  assert.equal(unreadableMessage('boom'), 'Mokapi: could not read the mocked request or response: boom');
  assert.equal(unreadableMessage(undefined), 'Mokapi: could not read the mocked request or response: undefined');
});

test('listener shows a notice when something other than an Error is thrown', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const panel = recorder();
  const worker = fakeWorker();
  validationHook(storyContext(worker), hookOptions(panel));
  worker.mocked(getProfile(), Object.assign(jsonResponse(), { clone() { throw 'locked'; } }));
  await settled();
  assert.equal(readNotice(panel)?.notice.message, 'Mokapi: could not read the mocked request or response: locked');
});

test('listener causes no unhandled rejection and throws nothing when every emit throws', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  const worker = fakeWorker();
  const context = storyContext(worker);
  // The hook's own emits (render-started) happen before the listener runs, so only the listener's emits throw.
  let broken = false;
  const emit = () => { if (broken) throw new Error('channel closed'); };
  validationHook(context, { emit, dashboardUrl, defaultTest: 'warning' });
  broken = true;
  assert.doesNotThrow(() => worker.mocked(getProfile(), jsonResponse()));
  assert.doesNotThrow(() => worker.mocked(getProfile(), unclonableResponse()));
  await settled();
  await settled();
  assert.deepEqual(rejections, []);
});

test('an unreadable pair fails the story in mode error with the notice as headline, and warns in mode warning', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.valid));
  for (const [mode, status] of [['error', 'failed'], ['warning', 'warning']]) {
    const worker = fakeWorker();
    const panel = recorder();
    const context = testContext(worker, { mokapi: { test: mode } });
    validationHook(context, hookOptions(panel));
    worker.started(getProfile());
    worker.mocked(getProfile(), unclonableResponse());
    await testHook(context, hookOptions(panel)).catch(() => {});
    assert.equal(context.reports[0]?.status, status);
    const report = panel.actions.find(({ type }) => type === 'report');
    assert.match(report.headline, /^Mokapi: could not read the mocked request or response: .*already used/);
    assert.equal(report.status, status);
  }
});

const judgedPanel = (storyId, report) => ({ ...initialPanelState, storyId, renderId: 3, testMode: 'warning', report });
const warningReport = { status: 'warning', headline: '1 response does not match the contract.', invalid: 1, valid: 0 };
const skippedReport = { status: 'passed', headline: '', invalid: 0, valid: 0 };

test('rememberResult keeps the state of a story with a verdict and ignores states without one', () => {
  const warned = judgedPanel('a--one', warningReport);
  const remembered = rememberResult({}, warned);
  assert.deepEqual(remembered, { 'a--one': warned });
  assert.equal(rememberResult(remembered, judgedPanel('a--one', skippedReport)), remembered);
  assert.equal(rememberResult(remembered, { ...initialPanelState, storyId: 'a--one' }), remembered);
  assert.equal(rememberResult(remembered, initialPanelState), remembered);
  const passed = judgedPanel('a--one', { status: 'passed', headline: '', invalid: 0, valid: 1 });
  assert.deepEqual(rememberResult(remembered, passed), { 'a--one': passed });
});

// Stories on a Docs page (docs.story.inline false) run in their own iframe, and each iframe counts its renderIds from 1.
// The manager gets their actions in one stream, in the order the manager's PANEL_EVENT handler receives them.
test('the results of a story on a Docs page are remembered for that story and not for another story with the same renderId', () => {
  const reportOf = (storyId, report) => ({ type: 'report', renderId: 1, storyId, ...report });
  const stream = [
    renderStarted(1, 'docs--invalid'),
    renderStarted(1, 'docs--no-request'),
    reportOf('docs--no-request', skippedReport),
    resultOf(1, 1, 'invalid', 'docs--invalid'),
    reportOf('docs--invalid', warningReport),
  ];
  // Like the manager: every action reaches the panel states, a report with a verdict is remembered.
  let panels = {};
  let remembered = {};
  for (const action of stream) {
    panels = reduceStoryPanels(panels, action);
    if (action.type === 'report' && !isSkippedReport(action)) remembered = rememberResult(remembered, panelOfStory(panels, action.storyId));
  }
  assert.deepEqual(Object.keys(remembered), ['docs--invalid']);
  assert.deepEqual(remembered['docs--invalid'].entries.map(({ status }) => status), ['invalid']);
  assert.deepEqual(panelOfStory(panels, 'docs--no-request').entries, []);
});

test('a render-started of one story leaves the state of another story', () => {
  const first = reduceStoryPanels({}, renderStarted(1, 'a--one'));
  const withResult = reduceStoryPanels(first, resultOf(1, 1, 'invalid', 'a--one'));
  const both = reduceStoryPanels(withResult, renderStarted(1, 'a--two'));
  assert.equal(both['a--one'], withResult['a--one']);
  assert.deepEqual(panelOfStory(both, 'a--two').entries, []);
});

test('a late result, notice or report of another story with the same renderId does not touch the state of a story', () => {
  const states = reduceStoryPanels(reduceStoryPanels({}, renderStarted(1, 'a--one')), renderStarted(1, 'a--two'));
  const afterOne = ['result', 'notice', 'report'].map((type) => reduceStoryPanels(states, {
    result: resultOf(1, 1, 'invalid', 'a--one'),
    notice: noticeOf(1, 'timeout', 'late', 'a--one'),
    report: { type: 'report', renderId: 1, storyId: 'a--one', ...warningReport },
  }[type]));
  for (const next of afterOne) assert.equal(next['a--two'], states['a--two']);
  assert.notEqual(afterOne[0]['a--one'], states['a--one']);
});

test('an action of a story that has not started is ignored, and a new mount of a story discards the results of its earlier renderId', () => {
  const empty = {};
  assert.equal(reduceStoryPanels(empty, resultOf(1, 1, 'invalid', 'a--one')), empty);
  const remounted = reduceStoryPanels(reduceStoryPanels(reduceStoryPanels({}, renderStarted(1, 'a--one')), renderStarted(2, 'a--one')), resultOf(1, 1, 'invalid', 'a--one'));
  assert.deepEqual(panelOfStory(remounted, 'a--one').entries, []);
  assert.equal(panelOfStory(remounted, 'a--one').renderId, 2);
});

test('forgetResults drops the given stories and returns the same object when none is known', () => {
  const results = { 'a--one': judgedPanel('a--one', warningReport), 'a--two': judgedPanel('a--two', warningReport) };
  assert.deepEqual(Object.keys(forgetResults(results, ['a--one', 'a--three'])), ['a--two']);
  assert.equal(forgetResults(results, ['a--three']), results);
});

test('the panel shows the last result of a story while its mount is running or skipped, and its own verdict otherwise', () => {
  const last = judgedPanel('a--one', warningReport);
  const results = { 'a--one': last };
  const running = { ...initialPanelState, storyId: 'a--one', renderId: 4, testMode: 'warning' };
  assert.equal(uiResultOf(running, results, 'a--one'), last);
  assert.equal(uiResultOf(judgedPanel('a--one', skippedReport), results, 'a--one'), last);
  assert.equal(uiResultOf(initialPanelState, results, 'a--one'), last);
  // after navigating to another story its state is in the slot, the result of the first story is still there
  assert.equal(uiResultOf(judgedPanel('a--two', warningReport), results, 'a--one'), last);

  const passed = judgedPanel('a--one', { status: 'passed', headline: '', invalid: 0, valid: 1 });
  assert.equal(uiResultOf(passed, results, 'a--one'), passed);
  // a first mount without a result shows its skip, a story without any state shows nothing
  const skipped = judgedPanel('a--one', skippedReport);
  assert.equal(uiResultOf(skipped, {}, 'a--one'), skipped);
  assert.equal(uiResultOf(initialPanelState, {}, 'a--one'), initialPanelState);
  assert.equal(uiResultOf(initialPanelState, {}, 'constructor'), initialPanelState);
});

test('a test run result stays in the panel for a story whose mount is skipped, and wins over the last UI result', () => {
  const last = judgedPanel('a--one', warningReport);
  const run = { report: { status: 'failed', headline: 'x', invalid: 0, valid: 0 }, entries: [], notices: [], testMode: 'error' };
  const skipped = judgedPanel('a--one', skippedReport);
  const panel = panelOf(uiResultOf(skipped, { 'a--one': last }, 'a--one'), { 'a--one': run }, 'a--one');
  assert.equal(panel.fromTestRun, true);
  assert.equal(panel.report.status, 'failed');
});

test('isSkippedReport is a passed report without a valid response', () => {
  assert.equal(isSkippedReport(skippedReport), true);
  assert.equal(isSkippedReport({ ...skippedReport, valid: 1 }), false);
  assert.equal(isSkippedReport({ ...warningReport }), false);
  assert.equal(isSkippedReport({ ...skippedReport, valid: undefined }), true);
});

test('isDisabled is true for a truthy disable parameter only', () => {
  assert.equal(isDisabled(undefined), false);
  assert.equal(isDisabled({}), false);
  assert.equal(isDisabled({ disable: false }), false);
  assert.equal(isDisabled({ disable: true }), true);
});

test('hintOf puts a disabled story before every other state', () => {
  for (const validationOn of [true, false]) {
    for (const fromTestRun of [true, false]) {
      assert.equal(hintOf({ disabled: true, validationOn, fromTestRun }), 'disabled');
    }
  }
});

test('hintOf asks for validation only when it is off and no test run result exists', () => {
  assert.equal(hintOf({ disabled: false, validationOn: false, fromTestRun: false }), 'validation-off');
  assert.equal(hintOf({ disabled: false, validationOn: false, fromTestRun: true }), undefined);
  assert.equal(hintOf({ disabled: false, validationOn: true, fromTestRun: false }), undefined);
  assert.equal(hintOf({ disabled: false, validationOn: true, fromTestRun: true }), undefined);
});

test('the help texts and the docs URL are the documented ones', () => {
  assert.equal(DOCS_URL, 'https://mokapi.io/docs/integrations/storybook');
  assert.equal(HELP_LINK_TEXT, 'Learn more about the Mokapi addon');
  assert.equal(HELP_ICON_LABEL, 'Mokapi addon documentation');
  assert.equal(DASHBOARD_LINK_LABEL, 'Open Mokapi dashboard');
  assert.deepEqual(DISABLED_HINT, { before: 'Validation is disabled for this story with ', code: 'parameters.mokapi.disable', after: '.' });
});
