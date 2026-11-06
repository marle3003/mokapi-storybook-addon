import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolveOptions } from '../dist/index.js';
import { forwardingUrl, validateRoute } from '../dist/forwarding.js';
import { previewAnnotations, managerEntries, managerHead, viteFinal } from '../dist/preset.js';
import { eventApis, eventsUrl, fetchEvents, panelSummary } from '../dist/mokapi-events.js';
import { http, HttpHandler, HttpResponse, graphql } from 'msw';
import { createStoryScenarios, createMokapiLoader } from 'mokapi-storybook-addon/msw';
import {
  initialMockBackend,
  mockBackendUrl,
  installManagerMockBackendSync,
  installPreviewMockBackendSync,
  PREVIEW_READY,
  MOCK_BACKEND_CHANGED,
} from '../dist/mock-backend-sync.js';

const target = 'http://localhost:3000';

test('core can be imported without MSW or msw-storybook-addon installed', async () => {
  const [core, packageJson] = await Promise.all([
    import('../dist/index.js'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  assert.equal(core.resolveOptions({ target }).defaultBackend, 'msw');
  assert.equal(core.createStoryScenarios, undefined);
  assert.equal(packageJson.peerDependenciesMeta.msw.optional, true);
  assert.equal(packageJson.dependencies?.['msw-storybook-addon'], undefined);
});

test('explicit integration delegates unchanged MSW stories to the project loader once', async () => {
  const parameters = createStoryScenarios({ success: [http.get('/api/profile', () => HttpResponse.json({}))] }).success;
  for (const context of [
    { parameters, globals: { mockBackend: 'msw' } },
    { parameters: {}, globals: { mockBackend: 'mokapi' } },
  ]) {
    let calls = 0;
    const original = context.parameters;
    const worker = {};
    const loader = createMokapiLoader(async (received) => {
      calls++;
      assert.equal(received, context);
      assert.equal(received.parameters, original);
      received.msw = worker;
      return { project: true };
    }, resolveOptions({ target }));
    assert.deepEqual(await loader(context), { project: true });
    assert.equal(calls, 1);
    assert.equal(context.msw, worker);
  }
});

test('explicit integration replaces only the selected handler group and restores parameters', async () => {
  const local = http.get('/auth', () => HttpResponse.json({}));
  const parameters = createStoryScenarios({
    success: [http.get('/api/profile', () => HttpResponse.json({}))],
  }, { handlerGroup: 'profile' }).success;
  parameters.msw.handlers.auth = [local];
  parameters.msw.handlers.disabled = null;
  const context = { parameters, globals: { mockBackend: 'mokapi' } };
  let forwarding;
  let calls = 0;
  const loader = createMokapiLoader(async (received) => {
    calls++;
    assert.equal(received, context);
    assert.deepEqual(received.parameters.msw.handlers.auth, [local]);
    assert.equal(received.parameters.msw.handlers.disabled, null);
    forwarding = received.parameters.msw.handlers.profile[0];
    assert.notEqual(forwarding, parameters.msw.handlers.profile[0]);
    assert.equal(forwarding.info.path, '/api/profile');
    assert.equal(forwarding.info.method, 'GET');
    received.msw = 'project worker';
    throw new Error('project setup failed');
  }, resolveOptions({ target }));
  await assert.rejects(loader(context), /project setup failed/);
  assert.equal(calls, 1);
  assert.equal(context.parameters, parameters);
  assert.equal(context.msw, 'project worker');
});

test('integration rejects invalid configuration before invoking the project loader', async () => {
  const loader = createMokapiLoader(() => assert.fail('loader must not run'), resolveOptions({ target }));
  await assert.rejects(loader({
    parameters: { mokapi: { scenario: 'success', routes: ['/api/profile'], handlerGroup: 'missing' } },
    globals: { mockBackend: 'mokapi' },
  }), /handler group "missing" is missing/);
  assert.throws(() => createMokapiLoader(undefined, resolveOptions({ target })), /project MSW loader/);
  assert.throws(() => createStoryScenarios({ success: [] }, { handlerGroup: '' }), /handlerGroup/);
});

test('integration replaces ungrouped handlers and preserves loader results and story parameters', async () => {
  const parameters = {
    msw: { handlers: [http.get('/api/profile', () => HttpResponse.json({}))], projectOption: true },
    mokapi: { scenario: 'success', routes: ['/api/profile'] },
    projectParameter: 'unchanged',
  };
  const context = { parameters, globals: { mockBackend: 'mokapi' } };
  const result = { loadedByProject: true };
  const load = createMokapiLoader((received) => {
    assert.equal(received.parameters.projectParameter, 'unchanged');
    assert.equal(received.parameters.msw.projectOption, true);
    const [handler] = received.parameters.msw.handlers;
    assert.notEqual(handler, parameters.msw.handlers[0]);
    assert.equal(handler.info.method, 'GET');
    assert.equal(handler.info.path, '/api/profile');
    return result;
  }, resolveOptions({ target }));

  assert.equal(await load(context), result);
  assert.equal(context.parameters, parameters);
});

test('integration rejects invalid backend and scenario parameters before loading', async () => {
  const load = createMokapiLoader(() => assert.fail('loader must not run'), resolveOptions({ target }));
  const config = { scenario: 'success', routes: ['/api/profile'] };
  await assert.rejects(load({
    parameters: { mokapi: config }, globals: { mockBackend: 'invalid' },
  }), /unknown backend/);
  for (const [invalidConfig, message] of [
    [{ ...config, scenario: ' ' }, /scenario is required/],
    [{ ...config, routes: [] }, /at least one route/],
    [{ ...config, routes: ['/api/:id'] }, /exact relative paths/],
  ]) {
    await assert.rejects(load({
      parameters: { mokapi: invalidConfig }, globals: { mockBackend: 'mokapi' },
    }), message);
  }
});

function syncHost() {
  const listeners = new Set();
  const host = {
    location: {
      href: 'http://localhost/iframe.html?id=example&globals=theme:dark;mockBackend:msw#section',
      origin: 'http://localhost', pathname: '/iframe.html',
      replace(url) { host.replacement = url; },
    },
    console,
    addEventListener(type, listener) { listeners.add(listener); },
    removeEventListener(type, listener) { listeners.delete(listener); },
    setTimeout,
    clearTimeout,
    receive(event) { for (const listener of listeners) listener(event); },
  };
  host.top = host;
  return host;
}

test('backend URL preserves other globals, parameters and fragment', () => {
  assert.equal(initialMockBackend('http://localhost/?globals=theme:dark;mockBackend:mokapi', 'msw'), 'mokapi');
  assert.equal(initialMockBackend('http://localhost/?globals=mockBackend:invalid', 'msw'), 'msw');
  assert.equal(initialMockBackend('http://localhost/', 'mokapi'), 'mokapi');
  const url = new URL(mockBackendUrl('http://localhost/iframe.html?id=story&globals=theme:dark;mockBackend:msw;locale:de#anchor', 'mokapi'));
  assert.equal(url.searchParams.get('id'), 'story');
  assert.equal(url.searchParams.get('globals'), 'theme:dark;locale:de;mockBackend:mokapi');
  assert.equal(url.hash, '#anchor');
  assert.equal(mockBackendUrl(url.href, 'mokapi'), url.href);
});

test('manager synchronizes registered previews and rejects foreign sources', () => {
  const manager = syncHost();
  const messages = [];
  const preview = syncHost();
  preview.top = manager;
  preview.postMessage = (data, origin) => messages.push({ data, origin });
  const sync = installManagerMockBackendSync(manager, () => 'mokapi');
  const event = { origin: 'http://localhost', source: preview, data: { type: PREVIEW_READY } };
  manager.receive({ ...event, origin: 'http://foreign' });
  preview.location.pathname = '/other.html';
  manager.receive(event);
  assert.equal(messages.length, 0);
  preview.location.pathname = '/iframe.html';
  manager.receive(event);
  assert.deepEqual(messages[0], { data: { type: MOCK_BACKEND_CHANGED, backend: 'mokapi' }, origin: 'http://localhost' });
  sync.update('msw');
  assert.equal(messages[1].data.backend, 'msw');
  sync.update('unknown');
  assert.equal(messages.length, 2);
  preview.closed = true;
  sync.update('mokapi');
  assert.equal(messages.length, 2);
  sync.dispose();
  manager.receive(event);
  assert.equal(messages.length, 2);
});

test('preview handshake waits, validates messages and reloads only when backend changes', async () => {
  const host = syncHost();
  const sent = [];
  host.location.href = mockBackendUrl(host.location.href, 'msw');
  host.top = { postMessage: (data, origin) => sent.push({ data, origin }) };
  const sync = installPreviewMockBackendSync(host);
  try {
    assert.deepEqual(sent[0], { data: { type: PREVIEW_READY }, origin: 'http://localhost' });
    const event = { origin: host.location.origin, source: host.top, data: { type: MOCK_BACKEND_CHANGED, backend: 'msw' } };
    host.receive({ ...event, source: {} });
    host.receive({ ...event, origin: 'http://foreign' });
    host.receive({ ...event, data: { type: PREVIEW_READY } });
    host.receive({ ...event, data: { type: MOCK_BACKEND_CHANGED, backend: 'unknown' } });
    assert.equal(host.replacement, undefined);
    host.receive(event);
    await sync.ready;
    assert.equal(host.replacement, undefined);
    host.receive({ ...event, data: { type: MOCK_BACKEND_CHANGED, backend: 'mokapi' } });
    assert.equal(new URL(host.replacement).searchParams.get('globals'), 'theme:dark;mockBackend:mokapi');
  } finally { sync.dispose(); }
});

test('preview reports a handshake timeout and removes its listener on disposal', async (t) => {
  const preview = syncHost();
  preview.top = { postMessage() {} };
  let onTimeout;
  const timer = {};
  preview.setTimeout = (callback, delay) => {
    assert.equal(delay, 10000);
    onTimeout = callback;
    return timer;
  };
  const clearedTimers = [];
  preview.clearTimeout = (value) => clearedTimers.push(value);
  const log = t.mock.fn();
  preview.console = { error: log };

  const sync = installPreviewMockBackendSync(preview);
  try {
    onTimeout();
    await assert.rejects(sync.ready, /backend synchronization timed out/);
    assert.equal(log.mock.calls.length, 1);
    assert.match(log.mock.calls[0].arguments[0].message, /backend synchronization timed out/);
  } finally {
    sync.dispose();
  }
  assert.deepEqual(clearedTimers, [timer]);
  preview.receive({
    origin: preview.location.origin,
    source: preview.top,
    data: { type: MOCK_BACKEND_CHANGED, backend: 'mokapi' },
  });
  assert.equal(preview.replacement, undefined);
});

test('new preview waits for reload before allowing loaders; standalone previews need no manager', async () => {
  const host = syncHost();
  await installPreviewMockBackendSync(host).ready;
  host.top = { postMessage() {} };
  const sync = installPreviewMockBackendSync(host);
  try {
    host.receive({ origin: host.location.origin, source: host.top, data: { type: MOCK_BACKEND_CHANGED, backend: 'mokapi' } });
    assert(host.replacement.includes('mockBackend%3Amokapi'));
    let ready = false;
    sync.ready.then(() => { ready = true; });
    await Promise.resolve();
    assert.equal(ready, false);
  } finally { sync.dispose(); }
  host.location.pathname = '/__vitest__/';
  await installPreviewMockBackendSync(host).ready;
});

test('factory derives matching MSW and Mokapi parameters without executing resolvers', () => {
  const handler = http.get('/api/profile', () => { throw new Error('Must not execute'); });
  const post = http.post('/api/profile', () => HttpResponse.json({}));
  const input = { success: [handler, handler, post], error: [http.get('/api/error', () => HttpResponse.json({}))] };
  const scenarios = createStoryScenarios(input);
  assert.deepEqual(Object.keys(scenarios), ['success', 'error']);
  assert.deepEqual(scenarios.success.msw.handlers, input.success);
  assert.notEqual(scenarios.success.msw.handlers, input.success);
  assert.deepEqual(scenarios.success.mokapi, {
    scenario: 'success',
    routes: [{ method: 'GET', path: '/api/profile' }, { method: 'POST', path: '/api/profile' }],
  });
  assert.equal(scenarios.error.mokapi.scenario, 'error');
  assert.equal(createStoryScenarios(input, { api: 'My API' }).success.mokapi.api, 'My API');
  assert.throws(() => createStoryScenarios(input, { api: '' }), /non-empty OpenAPI title/);
});

test('factory rejects unsupported handlers, paths and empty scenarios explicitly', () => {
  const resolver = () => HttpResponse.json({});
  for (const path of ['/api/:id', '/api/*', 'https://example.com/api', /api/, () => true]) {
    assert.throws(() => createStoryScenarios({ invalid: [http.get(path, resolver)] }), /exact relative paths/);
  }
  assert.throws(() => createStoryScenarios({ invalid: [graphql.query('Profile', resolver)] }), /HTTP handlers/);
  assert.throws(() => createStoryScenarios({ empty: [] }), /at least one HTTP handler/);
  assert.throws(() => createStoryScenarios({ ' ': [http.get('/api/profile', resolver)] }), /non-empty name/);
});

test('factory preserves all MSW method definitions through JSON serialization', () => {
  const resolver = () => HttpResponse.json({});
  const methods = ['QUERY', 'Custom-Method', 'TRACE'];
  const handlers = [...methods.map((method) => new HttpHandler(method, '/api/profile', resolver)),
    http.all('/api/profile', resolver), new HttpHandler(/GET|QUERY/i, '/api/profile', resolver)];
  const routes = JSON.parse(JSON.stringify(createStoryScenarios({ success: handlers }).success.mokapi.routes));
  assert.deepEqual(routes.slice(0, 3).map((route) => route.method), methods);
  assert.deepEqual(routes[3].method, { source: '.+', flags: '' });
  assert.deepEqual(routes[4].method, { source: 'GET|QUERY', flags: 'i' });
  const patternUrl = new URL(eventsUrl('/dashboard', 'API', routes[3], 1), 'http://localhost');
  assert.equal(patternUrl.searchParams.has('traits[method]'), false);
  assert.equal(validateRoute({ method: 'Custom-Method', path: '/test' }).method, 'Custom-Method');
});

test('forwarding handlers use MSW method matching for custom, wildcard and pattern methods', async () => {
  const resolver = () => HttpResponse.json({});
  for (const original of [
    new HttpHandler('QUERY', '/api/profile', resolver),
    new HttpHandler('PURGE', '/api/profile', resolver),
    http.all('/api/profile', resolver),
    new HttpHandler(/POST|QUERY/, '/api/profile', resolver),
  ]) {
    const config = JSON.parse(JSON.stringify(createStoryScenarios({ success: [original] })));
    const route = config.success.mokapi.routes[0];
    let forwarded;
    await createMokapiLoader((context) => {
      forwarded = context.parameters.msw.handlers[0];
    }, resolveOptions({ target }))({
      parameters: { mokapi: { scenario: 'success', routes: [route] } },
      globals: { mockBackend: 'mokapi' },
    });
    for (const method of ['GET', 'POST', 'QUERY', 'PURGE']) {
      const request = new Request('http://localhost/api/profile', { method });
      assert.equal(await forwarded.test({ request }), await original.test({ request }), method);
    }
  }
});

test('defaults and configurable scenario parameter', () => {
  assert.equal(resolveOptions({ target }).scenarioParameter, '__mockScenario');
  assert.equal(resolveOptions({ target, scenarioParameter: 'example' }).scenarioParameter, 'example');
  assert.throws(() => resolveOptions({ target, scenarioParameter: '' }), /must not be empty/);
  assert.throws(() => resolveOptions({ target, defaultBackend: 'unknown' }), /defaultBackend/);
  assert.equal(resolveOptions({ target }).dashboardUrl, 'http://localhost:8080');
  assert.throws(() => resolveOptions({ target, dashboardUrl: 'file:///tmp/test' }), /dashboardUrl/);
});

test('target has no default and must be an HTTP(S) URL', () => {
  assert.equal(resolveOptions({ target }).target, target);
  for (const options of [undefined, {}, { target: '' }, { target: 42 }]) {
    assert.throws(() => resolveOptions(options), /Mokapi: target is required/);
  }
  assert.throws(() => resolveOptions({ target: 'file:///tmp/test' }), /target must be an HTTP\(S\) URL/);
  assert.throws(() => viteFinal({}, {}), /target is required/);
});

test('forwards path, query and scenario without overwriting other parameters', () => {
  const url = forwardingUrl('http://localhost:6006/api/profile?name=a%20b&example=old', '/mock', 'example', 'error');
  assert.equal(url.pathname, '/mock/api/profile');
  assert.equal(url.searchParams.get('name'), 'a b');
  assert.equal(url.searchParams.get('example'), 'error');
  assert.equal(forwardingUrl('http://localhost/api/profile', 'http://remote:8080', '__mockScenario', 'success').host, 'remote:8080');
});

test('supports explicit HTTP methods and rejects patterns', () => {
  assert.deepEqual(validateRoute('/api/profile'), { method: 'GET', path: '/api/profile' });
  assert.deepEqual(validateRoute({ path: '/api/profile' }), { method: 'GET', path: '/api/profile' });
  assert.equal(validateRoute({ path: '/api/profile', method: 'POST' }).method, 'POST');
  assert.throws(() => validateRoute({ path: '/api/:id' }), /exact relative paths/);
});

test('preset installs annotation and proxy without exposing target to browser', () => {
  assert.equal(previewAnnotations(['existing'])[0], 'existing');
  const config = viteFinal({}, { target: 'http://internal:8080', proxyPath: '/mock', scenarioParameter: 'example' });
  assert.equal(config.server.proxy['/mock'].rewrite('/mock/api/profile?x=1'), '/api/profile?x=1');
  assert.equal(config.server.proxy['/mock'].target, 'http://internal:8080');
  assert.equal(JSON.parse(config.define.__MOKAPI_STORYBOOK_OPTIONS__).scenarioParameter, 'example');
  assert(!config.define.__MOKAPI_STORYBOOK_OPTIONS__.includes('internal'));
  assert.equal(config.server.proxy['/mock-dashboard'].target, 'http://localhost:8080');
  assert.equal(config.server.proxy['/mock-dashboard'].rewrite('/mock-dashboard/api/events?page=1'), '/api/events?page=1');
  assert.equal(Object.keys(config.server.proxy)[0], '/mock-dashboard');
  assert(managerEntries(['existing'])[1].endsWith('/manager.js'));
  const head = managerHead('existing', { target, dashboardUrl: 'http://dashboard:8081', proxyPath: '/mock' });
  assert(head.startsWith('existing'));
  assert(head.includes('"eventsUrl":"/mock-dashboard"'));
  assert(head.includes('"dashboardUrl":"http://dashboard:8081"'));
  assert(!managerHead('', { target, dashboardUrl: 'http://dashboard/</script>' }).includes('/</script>'));
});

test('event query filters by API, operation and page', () => {
  const url = new URL(eventsUrl('/mokapi-dashboard', 'Profile API', { path: '/api/profile', method: 'POST' }, 2), 'http://localhost');
  assert.equal(url.pathname, '/mokapi-dashboard/api/events');
  assert.equal(url.searchParams.get('traits[name]'), 'Profile API');
  assert.equal(url.searchParams.get('traits[namespace]'), 'http');
  assert.equal(url.searchParams.get('traits[path]'), '/api/profile');
  assert.equal(url.searchParams.get('traits[method]'), 'POST');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('size'), '25');
  const defaultMethod = new URL(eventsUrl('/mokapi-dashboard/', 'Profile API', '/api/profile', 1), url);
  assert.equal(defaultMethod.searchParams.get('traits[method]'), 'GET');
  assert.equal(defaultMethod.pathname, '/mokapi-dashboard/api/events');
  const patternMethod = new URL(eventsUrl('/mokapi-dashboard', 'Profile API', {
    path: '/api/profile', method: { source: 'POST|QUERY', flags: 'i' },
  }, 1), url);
  assert.equal(patternMethod.searchParams.has('traits[method]'), false);
});

test('event query omits the API trait when no API is given', () => {
  const url = new URL(eventsUrl('/mokapi-dashboard', undefined, { path: '/api/profile', method: 'POST' }, 3), 'http://localhost');
  assert.equal(url.searchParams.has('traits[name]'), false);
  assert.equal(url.searchParams.get('traits[namespace]'), 'http');
  assert.equal(url.searchParams.get('traits[path]'), '/api/profile');
  assert.equal(url.searchParams.get('traits[method]'), 'POST');
  assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('size'), '25');
});

test('panel summary names the API only when one is given', () => {
  assert.equal(panelSummary('Profile API', 'success'), 'API: Profile API | Scenario: success');
  assert.equal(panelSummary(undefined, 'success'), 'Scenario: success');
});

test('event APIs are the distinct, sorted API names of the events', () => {
  const event = (name) => ({ traits: { name } });
  assert.deepEqual(eventApis([]), []);
  assert.deepEqual(eventApis([event('Profile API')]), ['Profile API']);
  assert.deepEqual(
    eventApis([event('Profile API v2'), event('Profile API'), event('Profile API v2'), event('Profile API')]),
    ['Profile API', 'Profile API v2'],
  );
});

test('event loading filters decoded scenarios and preserves scripts, console logs and errors', async (t) => {
  const action = { tags: { file: 'profile.ts' }, logs: [{ level: 'info', message: 'Hello' }], error: 'Script failed' };
  const event = (id, scenario) => ({
    id, data: { request: { url: `http://localhost/api/profile?example=${scenario}` }, actions: [action] },
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    items: [event('1', 'server%20error'), event('2', 'success')], total: 27, page: 1, size: 25,
  }));
  const controller = new AbortController();
  const result = await fetchEvents('/events', 'server error', 'example', controller.signal);
  assert.deepEqual(result.items.map((item) => item.id), ['1']);
  assert.deepEqual(result.items[0].data.actions[0], action);
  assert.equal(result.total, 27);
  assert.equal(fetch.mock.calls[0].arguments[1].signal, controller.signal);
});

test('event loading surfaces HTTP, payload and network errors', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 503 }));
  await assert.rejects(fetchEvents('/events', 'success', 'example'), /HTTP 503/);
  fetch.mock.mockImplementation(async () => Response.json({ items: [{}], total: 1, page: 1, size: 25 }));
  await assert.rejects(fetchEvents('/events', 'success', 'example'), /invalid HTTP event/);
  fetch.mock.mockImplementation(async () => { throw new Error('Offline'); });
  await assert.rejects(fetchEvents('/events', 'success', 'example'), /Offline/);
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
