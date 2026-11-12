# mokapi-storybook-addon

Check your Storybook mocks against your OpenAPI contract with
[Mokapi](https://mokapi.io).

Your stories already use [MSW](https://mswjs.io) handlers to mock API
responses. This addon sends each mocked request and response to Mokapi, which
validates the pair against your OpenAPI contract. You keep your MSW setup and see
in the story when a mock drifts from the API.

- **One toolbar toggle:** an icon button that turns validation on or off. Off sends nothing.
- **Your MSW setup stays yours:** nothing Mokapi-specific goes into `.storybook/preview.ts` or into your stories.
- **Panel with badge:** every validated response shows as valid, invalid or not in the contract, with Mokapi's error messages. The tab shows how many are invalid.
- **Failing stories:** optionally, a story fails when its responses don't match the contract, so CI catches contract drift.
- **No change for the component:** it gets the MSW response unchanged and without delay.

![Storybook with Mokapi validation switched on: the story's MSW mock is missing the required email property, so the Mokapi panel lists the response as invalid with the error and the tab shows a badge](docs/screenshot.png)

## How it works

```
  Story renders, component calls fetch('/api/profile')
                      │
                      ▼
        MSW service worker answers with your handler
                      │ response:mocked event
                      ▼
          addon copies the request and response
                      │ POST <dashboardUrl>/api/services/http/validate
                      ▼
        Mokapi finds the operation in your OpenAPI
        contract and checks request and response
                      │
                      ▼
        Mokapi panel in Storybook: valid / invalid /
        not in contract, badge counts the invalid ones
```

The addon registers a `beforeEach` hook in its own preview annotations. Storybook
runs it after all loaders, so the MSW worker that your loader put in
`context.msw` already exists. The hook listens to the worker's `response:mocked`
event. It copies the request and the response, sends the copy to Mokapi and
shows the result in the panel. The addon never starts Mokapi or MSW and imports
nothing from `msw`.

Only responses from your handlers are validated. Requests that you pass through
with `passthrough()` or that no handler matches are not sent.

## Requirements

- [Mokapi](https://mokapi.io/docs/get-started/installation) 0.58.0 or newer
- Storybook 10.6.4 or newer with the Vite builder and CSF3 stories
- MSW 2.15.0 or newer
- React 18 or newer (used for the addon panel only)
- Node.js 22.12.0 or newer

## Quick start

This example assumes that your Storybook already uses MSW with
`msw-storybook-addon`.

### 1. Install

```sh
npm install --save-dev mokapi-storybook-addon
```

Install Mokapi as well if you don't have it yet, for example, with
`npm install --save-dev go-mokapi`.

### 2. Register the addon

```ts
// .storybook/main.ts
export default {
  framework: '@storybook/react-vite',
  addons: [
    {
      name: 'mokapi-storybook-addon',
      options: {
        dashboardUrl: 'http://localhost:8080', // default
        defaultValidation: false,              // default
      },
    },
  ],
};
```

Both options are optional. Without options, the addon uses the Mokapi dashboard
at `http://localhost:8080` and starts with validation off.

### 3. Keep your MSW setup

Your `.storybook/preview.ts` needs no addon code:

```ts
// .storybook/preview.ts
import { setupWorker } from 'msw/browser';
import { mswLoader } from 'msw-storybook-addon/csf3';

export default {
  loaders: [
    mswLoader(async () => {
      const worker = setupWorker();
      await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
      return worker;
    }),
  ],
};
```

`msw-storybook-addon` is optional. If you use your own loader, it must set
`context.msw` to the worker (or server) that answers your requests. The addon
reads the worker from there.

### 4. Write stories

Stories stay plain MSW:

```ts
// src/Profile.stories.ts
import { http, HttpResponse } from 'msw';
import { Profile } from './Profile';

export default { title: 'Profile', component: Profile };

export const Valid = {
  parameters: {
    msw: {
      handlers: [
        http.get('/api/profile', () =>
          HttpResponse.json({ name: 'Jane Doe', email: 'jane@example.com' }),
        ),
      ],
    },
  },
};
```

### 5. Start Mokapi and Storybook

Start Mokapi with your OpenAPI contract, then Storybook:

```sh
npx mokapi ./openapi.json
npx storybook dev
```

Open a story, click the **Validate with Mokapi** icon button in the toolbar to
switch validation on and open the **Mokapi** panel.

## Toggle

The toolbar has one icon button, **Validate with Mokapi**. One click switches
validation on or off. The button is highlighted while validation is on, and its
tooltip shows the state:

- `Mokapi validation is on. Click to turn off.`
- `Mokapi validation is off. Click to turn on.`

The button sets the global `mokapiValidation` to `on` or `off`. The initial value
comes from `defaultValidation`. With `defaultValidation: true`, the button starts
highlighted. Assistive technology reads the button as a switch named "Validate
with Mokapi" that is checked while validation is on.

The button only appears in story view, not on Docs pages, because the story
remount below only works there.

Switching does not reload the preview. The addon remounts the current story, so
a component that fetches on mount requests its data again. When you switch
validation on, those requests are validated right away, and the panel list
starts empty.

## Choosing the API

Mokapi can serve several APIs. Without `parameters.mokapi.api`, Mokapi searches
all of them for an operation that matches the request's method and path.

If more than one API matches, Mokapi can't choose. The addon then shows the
request as **not in contract**, and the entry contains Mokapi's message with the
names of the matching APIs. To fix it, set the API's `info.title`:

```ts
// .storybook/preview.ts, a story file or a single story
export default {
  parameters: {
    mokapi: { api: 'Profile API' },
  },
};
```

`parameters.mokapi` is inherited from preview, component and story, as other
Storybook parameters. A story can overwrite the value of the project.

If `api` names an API that Mokapi doesn't know, the panel shows a notice with
Mokapi's message, see [Errors](#errors).

## Disabling a story

A story that has no contract, for example a mock for a third-party API, can opt
out:

```ts
export const ThirdParty = {
  parameters: {
    mokapi: { disable: true },
    msw: { handlers: [/* ... */] },
  },
};
```

The addon sends nothing to Mokapi for this story, also when the toggle is on.

## Panel and badge

The **Mokapi** panel shows the responses of the selected story since it was
mounted. A re-render that keeps the component, for example a change in Controls
or in a toolbar, keeps the list and adds the responses of the new requests.
Switching to another story, **Reload Story** and switching validation start a
new list. Each entry shows the method, URL, HTTP status of the response and time,
and one of these results:

| Result                 | Meaning                                                                          |
|------------------------|----------------------------------------------------------------------------------|
| valid                  | Request and response fit the contract. The request links to the matched operation |
| invalid                | The contract is violated. The entry lists each error with its `location` (for example `response.body`) and message |
| not in contract        | Mokapi found no operation for the request, or several APIs match. The entry shows Mokapi's message |
| Mokapi not reachable   | The request to Mokapi failed. The entry shows the URL and a hint to `dashboardUrl` |

In valid and invalid entries, the request (for example `GET /api/profile/1`)
links to the page of the operation Mokapi matched in the Mokapi dashboard and
opens in a new tab. Hover the link to see the operation, for example
`GET /profile/{id}`. Entries that are not in the contract or not reachable have
no link.

The tab title shows a badge with the number of invalid responses. Responses that
are not in the contract and not-reachable entries are not counted.

While validation is on, the panel also shows the test mode of the selected
story, so you can see what a CI run does with it, see
[Failing stories](#failing-stories):

- `Test mode: error. Contract errors make this story fail.`
- `Test mode: todo. Contract errors are reported as warnings, the story stays green.`
- `Test mode: off. Contract errors are shown here only.`

The panel doesn't show a mode when validation is off or the story sets
`parameters.mokapi.disable`. You can't change the mode in the panel, it is set in
code only.

Notices appear at the top of the panel when the addon can't validate:

- Mokapi is not reachable.
- The Mokapi at `dashboardUrl` has no validation endpoint and must be updated to 0.58.0.
- Mokapi reports a configuration error, for example an unknown `api`.
- `parameters.mokapi.test` has an invalid value.
- A validation did not finish in time, see [Failing stories](#failing-stories).
- The MSW worker is missing from `context.msw`.

The exact texts are listed in [Errors](#errors). With validation off, the panel
shows a hint how to turn it on. The panel also links to the Mokapi dashboard.

## Failing stories

By default, contract errors only show up in the panel. In CI nobody looks at the
panel, so a story can fail instead. The test mode decides what happens when a
story has a failing result:

| Mode               | Report status | Story                                                                 |
|--------------------|---------------|-----------------------------------------------------------------------|
| `'error'`          | `failed`      | Storybook shows its error display and finishes the story with status `error` |
| `'todo'` (default) | `warning`     | The story stays green                                                 |
| `'off'`            | no report     | The story stays green                                                 |

Set the default for all stories in `.storybook/main.ts`:

```ts
// .storybook/main.ts
export default {
  addons: [
    {
      name: 'mokapi-storybook-addon',
      options: {
        defaultValidation: true,
        defaultTest: 'error',
      },
    },
  ],
};
```

`parameters.mokapi.test` overrides it for a story, a component or the whole
project:

```ts
export const Legacy = {
  parameters: {
    mokapi: { test: 'todo' },
  },
};
```

The test mode only applies while validation is on. It never turns validation on
by itself. In CI, set `defaultValidation: true` or open the story with
`globals=mokapiValidation:on`.

### What fails

A failing result is:

- an invalid response
- Mokapi is not reachable, or the Mokapi at `dashboardUrl` has no validation endpoint
- a configuration error, for example an unknown `api` or an invalid `parameters.mokapi.test`
- a validation that did not finish within 4 s

These don't count, they only show in the panel: responses that are not in the
contract (a project with partial contracts would get a warning on every story)
and a missing MSW worker. A story without requests passes.

Before it reports, the story waits for the requests that its handlers answer, and
for their validation. Requests that MSW passes through or that no handler
matches are dropped, so they don't block the story. The wait is capped at 4 s
including the short quiet window described in [Limitations](#limitations). If a
validation is still open then, the story fails with
`Mokapi validation did not finish within 4 s (GET /api/profile/1).`, one request
per line if several.

### Error message

In `'error'` mode the story throws an error like this:

```
Mokapi: 1 response does not match the contract.

GET /api/profile/1 -> GET /profile/{id} (http://localhost:8080/dashboard/http/services/Profile%20API/profile/%7Bid%7D/get)
  response.body: missing required property 'name'
```

With several invalid responses, the headline reads
`Mokapi: N responses do not match the contract.` The headline counts invalid
responses only. Other failing results (not reachable, endpoint missing,
configuration error, timeout) follow as lines with the same text as in the
panel. Without an invalid response there is no headline.

### Test with Playwright

Open the story with validation on and check Storybook's error state. Storybook
adds the class `sb-show-errordisplay` to the body of the preview iframe and
writes the message into `#error-message` and `#error-stack`:

```ts
import { test, expect } from '@playwright/test';

test('Profile mock matches the contract', async ({ page }) => {
  await page.goto('http://localhost:6006/iframe.html?id=profile--valid&viewMode=story&globals=mokapiValidation:on');
  await page.waitForLoadState('networkidle');

  await expect(page.locator('body.sb-show-errordisplay')).toHaveCount(0);
});

test('a drifted mock fails the story', async ({ page }) => {
  await page.goto('http://localhost:6006/iframe.html?id=profile--invalid&viewMode=story&globals=mokapiValidation:on');

  await expect(page.locator('body.sb-show-errordisplay')).toBeVisible();
  await expect(page.locator('#error-message, #error-stack')).toContainText(
    'Mokapi: 1 response does not match the contract.',
  );
});
```

The first test expects a story whose mock fits the contract, the second one a
story with an invalid mock under `defaultTest: 'error'`. Adjust the story ids to
your project. You can also listen to Storybook's `storyFinished` channel event,
its payload has `status: 'error'` for a failed story.

### Vitest

With `@storybook/addon-vitest`, a story in `'error'` mode fails its test with the
Mokapi message, the same text as in the error display. Set
`defaultValidation: true` so that the stories are validated, and make sure that
Mokapi runs with your contract while Vitest runs. Stories in `'todo'` and
`'off'` pass.

The addon adds its result with Storybook's reporting API as a report of type
`mokapi`, with the status `passed`, `warning` or `failed`.

In Storybook's testing module (**Run tests** below the sidebar), stories in
`'error'` mode with a failing result are listed as failed and get a red status in
the sidebar. A `warning` from a story in `'todo'` mode is not shown there: the
story stays green. Open the **Mokapi** panel to see its contract errors.

## Docs pages

Use Storybook's Docs page with stories that are not inline:

```ts
// .storybook/preview.ts
export default {
  parameters: {
    docs: { story: { inline: false, iframeHeight: '300px' } },
  },
};
```

Each story then runs in its own iframe with its own MSW worker. Inline stories
share one worker, so the addon can't attribute their results to a story. See
[Limitations](#limitations).

The toolbar button is not shown on Docs pages. Switch validation on in story
view first, or set `defaultValidation: true`.

## Static builds and deployment

The browser calls Mokapi directly. The addon sets up no proxy, so `storybook dev`
and `storybook build` use the same `dashboardUrl`. It must be an address that the
browser of every viewer can reach, not only the machine that builds Storybook.

Mokapi answers the request with `Access-Control-Allow-Origin: *`, so no CORS
setup is needed.

A Storybook served over HTTPS can't call Mokapi on a plain `http://` address other
than `localhost`: browsers block this as mixed content. Chrome and Firefox allow
`http://localhost`, but Chrome may ask for permission to access the local network,
and other browsers may still block it. Put Mokapi behind an HTTPS reverse proxy
and use its address as `dashboardUrl`, or run Storybook over HTTP while you
validate.

Only expose the dashboard API to trusted users. Don't put credentials in
`dashboardUrl`, because the option is visible in the browser.

## API

### Addon options

Set in `.storybook/main.ts`. Restart Storybook after changing them.

| Option              | Type      | Default                   | Description                                         |
|---------------------|-----------|---------------------------|-----------------------------------------------------|
| `dashboardUrl`      | `string`  | `'http://localhost:8080'` | Mokapi dashboard URL, must be reachable from the browser. A trailing slash is removed |
| `defaultValidation` | `boolean` | `false`                   | Initial state of the toolbar toggle. `true` starts with validation on and the button highlighted |
| `defaultTest`       | `'error' \| 'todo' \| 'off'` | `'todo'`      | Test mode of all stories, see [Failing stories](#failing-stories) |

### `parameters.mokapi`

| Field     | Type      | Description                                                                 |
|-----------|-----------|-----------------------------------------------------------------------------|
| `api`     | `string`  | OpenAPI `info.title` of the story's API. Optional, see [Choosing the API](#choosing-the-api) |
| `disable` | `boolean` | Sends nothing to Mokapi for this story                                      |
| `test`    | `'error' \| 'todo' \| 'off'` | Overrides `defaultTest` for this story, see [Failing stories](#failing-stories) |

### Global `mokapiValidation`

| Value   | Description                                     |
|---------|-------------------------------------------------|
| `'on'`  | Validate the responses of the mocked requests   |
| `'off'` | Validate nothing (default)                      |

The toolbar button switches the global. You can set the initial value with
`defaultValidation`, or with the URL parameter `globals=mokapiValidation:on`.

### TypeScript

Type definitions are included. Importing `mokapi-storybook-addon` adds
`mokapi` to Storybook's `Parameters` type. The package also exports the type
`TestMode`.

## Errors

Invalid options throw an error when Storybook starts:

- `Mokapi: dashboardUrl must be an HTTP(S) URL.`
- `Mokapi: defaultValidation must be true or false.`
- `Mokapi: defaultTest must be 'error', 'todo' or 'off'.`

The panel shows these notices. None of them counts in the badge. They don't stop
the story either, unless the test mode is `'error'` and the notice is a failing
result, see [Failing stories](#failing-stories):

| Notice | Cause and fix |
|--------|---------------|
| `Mokapi is not reachable at <url>. Check the dashboardUrl option and that Mokapi is running.` | The request failed. Start Mokapi or fix `dashboardUrl` |
| `Mokapi at <url> does not support /api/services/http/validate. Update Mokapi to 0.58.0.` | Your Mokapi is older than 0.58.0 |
| Mokapi's message, for example for an unknown API | `parameters.mokapi.api` names an API that Mokapi doesn't serve. Use the `info.title` of your contract |
| `Mokapi answered HTTP <status>: <message>` | Any other unexpected answer from Mokapi. Mokapi's message is added if it sent one |
| `Mokapi: parameters.mokapi.test must be 'error', 'todo' or 'off'.` | A story, component or preview sets an invalid test mode. The story uses `defaultTest` |
| `Mokapi validation did not finish within 4 s (<method> <path>).` | MSW or Mokapi did not answer in time. One notice per unfinished request |
| ``MSW worker not found: `context.msw` is missing. Use `mswLoader` or set `context.msw` in your loader.`` | The story has no MSW worker. Use `mswLoader` or set `context.msw` in your own loader |

In test mode `'error'`, the story fails with the message described in
[Error message](#error-message). Its headline is
`Mokapi: <N> response(s) do(es) not match the contract.`, followed by one line per
invalid response with its errors, and the notice texts of the other failing
results.

The notice about a missing worker only appears while validation is on. With
validation off, a story without a worker runs without any message.

## Limitations

- Inline Docs stories share one MSW worker, so their results can't be attributed
  to a story. Use `inline: false`, see [Docs pages](#docs-pages). If you keep inline
  stories that share one preview, results may be attributed to the wrong story.
- The test mode waits until no new request has started for 100 ms (at most 1 s),
  then for the requests that started before. A request that starts later, for
  example from polling or a timer, is not counted. It still appears in the panel.
- The wait for validations is a fixed 4 s and includes that quiet window. You can't
  configure it.
- Opaque responses emit no MSW event, so a request that gets one only ends by the
  4 s timeout.
- In `'error'` mode, `STORY_FINISHED.reporters` is empty for a failed story,
  because Storybook finishes the story without reports when `afterEach` throws. Use the error
  display or `status: 'error'`. In `'todo'` mode the report is there.
- If a handler throws, MSW answers with its own 500. The addon doesn't validate
  that response.
- Only responses from MSW handlers are validated, not `passthrough()` or
  unhandled requests.
- The addon needs a worker (or server) with MSW's `events.on` in `context.msw`.
- Mokapi validates the request and response pair against the contract. It does
  not run your handlers.
- Storybook with Vite and CSF3 only. Webpack and CSF Next are not supported.
  Only React projects are tested.
- A Storybook served over HTTPS can't reach Mokapi on a plain `http://` address, see
  [Static builds and deployment](#static-builds-and-deployment).
- Requires Mokapi 0.58.0 or newer, see [Requirements](#requirements).

## License

[MIT](LICENSE)
