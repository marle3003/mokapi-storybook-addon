# mokapi-storybook-addon

Check your Storybook mocks against your OpenAPI contract with
[Mokapi](https://mokapi.io).

Your stories already use [MSW](https://mswjs.io) handlers to mock API
responses. This addon adds a toolbar switch to Storybook: run the handlers in
the browser as usual, or send the same requests to Mokapi, which validates every
response against your OpenAPI contract. You keep one set of mocks and see in the
story when they drift from the API.

- **One toolbar switch:** change between **MSW (browser)** and **Mokapi (OpenAPI validation)** for all stories.
- **Same mocks:** stories reuse your existing MSW handlers. Together with
  [mokapi-msw-adapter](https://github.com/marle3003/mokapi-msw-adapter), Mokapi
  serves the same handlers.
- **Request panel:** see each request in Storybook, with status, response body,
  contract errors, script logs and errors.
- **Your MSW setup stays yours:** the addon does not start MSW or Mokapi and does
  not import your mock modules.

![Storybook with the Mokapi toolbar switch and the Mokapi panel: the story's mock is missing the required email property, so Mokapi answers with HTTP 500 and the panel shows the validation error](docs/screenshot.png)

## How it works

```
                      Storybook toolbar: mockBackend
                 ┌───────────────┴────────────────┐
                 ▼                                ▼
               msw                             mokapi
     story handlers run in the      requests are forwarded through the
     browser (MSW service worker)   Vite proxy /mokapi to Mokapi, with
                                    ?__mockScenario=<scenario>
                                                  │
                                                  ▼
                                    Mokapi answers with your shared
                                    handlers (mokapi-msw-adapter) and
                                    validates against OpenAPI
                                                  │
                                                  ▼
                                    Mokapi panel shows the requests
                                    (dashboard API /api/events)
```

In MSW mode, nothing changes: `parameters.msw` goes to your MSW loader
unchanged. In Mokapi mode, the addon replaces the story's handlers with
forwarding handlers. They send each request to Mokapi and add the story's
scenario as a query parameter. Mokapi's answer, including a validation error,
goes back to your component unchanged.

## Requirements

- [Mokapi](https://mokapi.io/docs/get-started/installation) 0.53.0 or newer
  (0.56.0 or newer with mokapi-msw-adapter)
- Storybook 10.6.4 or newer with the Vite builder and CSF3 stories
- MSW 2.15.0 or newer
- React 18 or newer (used for the addon panel only)
- Node.js 22.12.0 or newer

## Quick start

This example assumes that your shared MSW handlers are in
`src/mocks/profile.ts` and that Mokapi serves them with mokapi-msw-adapter. See
its [Quick start](https://github.com/marle3003/mokapi-msw-adapter#quick-start)
for the handler module, `mokapi.yaml` and the OpenAPI contract.

### 1. Install

```sh
npm install --save-dev mokapi-storybook-addon msw msw-storybook-addon
```

Generate `mockServiceWorker.js` with MSW's standard setup
(`npx msw init public`) and serve it from Storybook.

### 2. Register the addon

```ts
// .storybook/main.ts
export default {
  framework: '@storybook/react-vite',
  staticDirs: ['../public'],
  addons: [
    {
      name: 'mokapi-storybook-addon',
      options: {
        target: 'http://localhost:3000', // your API in Mokapi
      },
    },
  ],
};
```

`target` is required: use the server URL from your OpenAPI contract. The
addon adds the toolbar switch, the **Mokapi** panel and a Vite development
proxy from `/mokapi` to `target`. The panel reads requests from the Mokapi
dashboard at `http://localhost:8080`. If you run the dashboard elsewhere, set
`dashboardUrl`.

### 3. Wrap your MSW loader

```ts
// .storybook/preview.ts
import { setupWorker } from 'msw/browser';
import { mswLoader } from 'msw-storybook-addon/csf3';
import { createMokapiLoader } from 'mokapi-storybook-addon/msw';

const loadMsw = mswLoader(async () => {
  const worker = setupWorker(); // Your initial handlers can go here.
  await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
  return worker;
});

export default {
  loaders: [createMokapiLoader(loadMsw)],
  parameters: { docs: { story: { inline: false, iframeHeight: '300px' } } },
};
```

Register only the wrapped loader. If you also register `loadMsw` directly, both
reset the MSW handlers.

`msw-storybook-addon` is optional: any loader that reads `parameters.msw` works.
Your loader keeps creating, starting and resetting the worker.

### 4. Write stories

```ts
// src/Profile.stories.ts
import { createStoryScenarios } from 'mokapi-storybook-addon/msw';
import { scenarios as profileScenarios } from './mocks/profile';

const scenarios = createStoryScenarios(profileScenarios, { api: 'My API' });

export const Success = {
  parameters: scenarios.success,
};

export const ServerError = {
  parameters: scenarios.error,
};
```

`api` is the OpenAPI `info.title`. The request panel needs it.

### 5. Start Mokapi and Storybook

```sh
npx mokapi
npx storybook dev
```

Open a story and switch the toolbar from **MSW (browser)** to
**Mokapi (OpenAPI validation)**. The story reloads and its requests go to Mokapi.
Open the **Mokapi** panel to see them.

## Scenarios

`createStoryScenarios()` turns your named handler lists into story parameters:

```ts
scenarios.success
// {
//   msw: { handlers: [/* your handlers */] },
//   mokapi: { scenario: 'success', api: 'My API', routes: [{ method: 'GET', path: '/api/profile' }] },
// }
```

- Scenario names stay typed: `scenarios.sucess` is a TypeScript error.
- Routes are read from the handlers' method and path. The resolvers do not run,
  and duplicate routes are merged.
- An empty handler list, a non-HTTP handler (for example GraphQL) or a path
  pattern throws an error.

In Mokapi mode, each forwarded request carries `?__mockScenario=<scenario>`.
Other query parameters, the method, headers, the body and the abort signal are
kept. The adapter uses the parameter to pick the scenario.

If you rename the parameter, configure the same name in both places:

```ts
// .storybook/main.ts
options: { scenarioParameter: 'example' }

// src/mocks/profile.ts
register(scenarios, { api: 'My API', scenarioParameter: 'example' });
```

To add other parameters, spread the scenario:

```ts
export const Success = {
  parameters: {
    ...scenarios.success,
    docs: { description: { story: 'Successful profile request.' } },
  },
};
```

You can also write `msw: { handlers }` and `mokapi: { scenario, routes }`
yourself. Stories without `parameters.mokapi` always use MSW.

## Keep other handlers local

By default, Mokapi mode replaces all story handlers. To keep unrelated handlers
in the browser, for example for authentication, put the Mokapi handlers in a
named MSW handler group:

```ts
const scenarios = createStoryScenarios(profileScenarios, {
  api: 'My API',
  handlerGroup: 'profile',
});

export const Success = {
  parameters: {
    ...scenarios.success,
    msw: { handlers: { ...scenarios.success.msw.handlers, auth: authHandlers } },
  },
};
```

In Mokapi mode, only the `profile` group is replaced. Other groups, including
groups set to `null`, stay as they are. A missing group throws an error. Only
the handlers in the selected group must fit
[the adapter's supported MSW API](https://github.com/marle3003/mokapi-msw-adapter#supported-msw-api).

## Request panel

Select a story, switch the toolbar to Mokapi and open the **Mokapi** panel. For
each request, it shows:

- time, HTTP status and duration
- request and response metadata and the response body, including contract
  validation errors
- executed scripts with console logs, parameters and errors

HTTP errors and script errors are shown separately: an intended HTTP 500 is not
a contract violation.

If the story has several routes, select an operation. The panel loads that
operation's requests from Mokapi's dashboard API and keeps those whose
scenario parameter matches the story. It shows the operation's history, not one
story execution. Requests without the scenario parameter are not shown.

- The panel refreshes every two seconds while it is open in Mokapi mode.
  **Refresh** reloads immediately.
- Pages hold 25 requests and are filtered after loading, so a page can be empty
  while other pages contain matches.
- Errors appear in the panel and never block the story.

The panel needs `parameters.mokapi.api`, set by the `api` option of
`createStoryScenarios()`.

## Docs pages

Use Storybook's standard Docs page with stories that are not inline:

```ts
// .storybook/preview.ts
export default {
  parameters: {
    docs: { story: { inline: false, iframeHeight: '300px' } },
  },
};
```

Each story then runs in its own iframe with its own MSW worker. Inline stories
share one worker, so they can't show different scenarios.

When you change the toolbar, the addon reloads every Storybook preview iframe,
including the story iframes on a Docs page, with the new `mockBackend`. Other
globals, query parameters and fragments are kept. Loaders wait for this
synchronization, so a new iframe never uses the wrong backend. Without the
Storybook manager, for example in a standalone preview, the `mockBackend` URL
global or `defaultBackend` applies.

## Static builds and deployment

`storybook build` has no Vite server, so the `/mokapi` proxy is missing. Choose
one of these:

- Provide a reverse proxy for `/mokapi` (to `target`) and `/mokapi-dashboard`
  (to `dashboardUrl`).
- Set `browserUrl` at build time and enable CORS in Mokapi. The browser then
  calls Mokapi directly.

The panel's dashboard link uses `dashboardUrl` directly, so use an address your
users can reach. Only expose the dashboard API to trusted users: the request
history can contain sensitive headers, bodies and script data. Don't put
credentials in any option, because the options are visible in the browser.

## API

### Addon options

Set in `.storybook/main.ts`. Restart Storybook after changing them.

| Option              | Type                  | Default                 | Description                                                                 |
|---------------------|-----------------------|-------------------------|-----------------------------------------------------------------------------|
| `target`            | `string`              | required                | Mocked API in Mokapi, target of the `proxyPath` proxy. Not sent to the browser |
| `dashboardUrl`      | `string`              | `'http://localhost:8080'` | Mokapi dashboard, target of the `<proxyPath>-dashboard` proxy and of the panel link |
| `proxyPath`         | `string`              | `'/mokapi'`             | Local proxy path, removed before forwarding                                 |
| `defaultBackend`    | `'msw' \| 'mokapi'`   | `'msw'`                 | Initial toolbar selection                                                   |
| `scenarioParameter` | `string`              | `'__mockScenario'`      | Query parameter that selects the scenario                                   |
| `browserUrl`        | `string`              | not set                 | Mokapi address used by the browser instead of `proxyPath`, see [Static builds and deployment](#static-builds-and-deployment) |

### `createStoryScenarios(scenarios, options)`

Imported from `mokapi-storybook-addon/msw`.

| Parameter              | Type                            | Default  | Description                                             |
|------------------------|---------------------------------|----------|---------------------------------------------------------|
| `scenarios`            | `Record<string, HttpHandler[]>` | –        | MSW handlers grouped by scenario name                   |
| `options.api`          | `string`                        | not set  | OpenAPI `info.title`, needed by the request panel       |
| `options.handlerGroup` | `string`                        | not set  | MSW handler group managed by Mokapi, see [Keep other handlers local](#keep-other-handlers-local) |

Returns one story parameters object (`msw` and `mokapi`) per scenario.

### `createMokapiLoader(loader, options)`

Imported from `mokapi-storybook-addon/msw`. Wraps your MSW loader. In Mokapi
mode, the loader receives forwarding handlers in `parameters.msw`. The original
parameters are restored afterwards, also when the loader throws. The loader's
result and its changes to the context are kept.

`options` (`proxyPath`, `scenarioParameter`, `browserUrl`) is only needed
without the registered addon, for example in tests.

### `parameters.mokapi`

| Field          | Type                                             | Description                                     |
|----------------|--------------------------------------------------|-------------------------------------------------|
| `scenario`     | `string`                                         | Value of the scenario query parameter           |
| `routes`       | `Array<string \| { method?, path }>`             | Routes to forward. A string means `GET`         |
| `api`          | `string`                                         | OpenAPI `info.title`, needed by the panel       |
| `handlerGroup` | `string`                                         | MSW handler group to replace                    |

### TypeScript

Type definitions are included. Importing `mokapi-storybook-addon` adds
`mokapi` to Storybook's `Parameters` type.

### HTTP methods

All MSW HTTP methods are forwarded: the `http.*` helpers, `http.all()` and
string or RegExp methods in `new HttpHandler(...)`, for example `QUERY`. RegExp
methods are stored as `{ source, flags }` in the story parameters. Mokapi checks
the actual method against the contract. The browser's Fetch API still applies:
it doesn't allow `CONNECT`, `TRACE` or `TRACK`.

## Errors

- If Mokapi can't be reached, the addon logs the error and answers with HTTP 502.
  It never falls back to the local mocks.
- HTTP errors from Mokapi, including contract validation errors, go to the
  component unchanged.
- Invalid options or story parameters throw an error that starts with `Mokapi:`.
- If the preview gets no answer from the Storybook manager within 10 seconds,
  loaders fail with `backend synchronization timed out`. Reload Storybook.

## Limitations

- Only exact relative paths. Path patterns such as `/users/:id` or `/files/*`,
  query strings in routes and absolute URLs are not supported.
- Only MSW HTTP handlers can be forwarded. To keep GraphQL or WebSocket
  handlers in Mokapi mode, put them in another handler group, see
  [Keep other handlers local](#keep-other-handlers-local).
- Storybook with Vite and CSF3 only. Webpack and CSF Next are not supported.
  Only React projects are tested.
- Preview iframes must have the same origin as the Storybook manager.
- The panel shows the request history per operation, not exactly the requests of
  one story execution.
- In Mokapi mode, mokapi-msw-adapter supports JSON responses only.

## License

[MIT](LICENSE)
