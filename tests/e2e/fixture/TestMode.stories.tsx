import { useEffect, useState } from 'react';
import { delay, http, HttpResponse, passthrough } from 'msw';
import { jane, profileHandler, userHandler } from './handlers';
import { Profile } from './Profile';

// Same title as Profile.stories.tsx, so the ids are profile--error-invalid etc. The file is left out of
// Storybook when MOKAPI_SCREENSHOT is set (.storybook/main.ts).
export default { title: 'Profile', component: Profile };

// Stories for the test mode (`parameters.mokapi.test`). The name tells the mode and what the story does.

// The contract requires `email`.
const invalidProfile = { name: 'Jane Doe' };

export const ErrorInvalid = {
  parameters: { mokapi: { test: 'error' }, msw: { handlers: [profileHandler(invalidProfile)] } },
};

export const WarningInvalid = {
  parameters: { mokapi: { test: 'warning' }, msw: { handlers: [profileHandler(invalidProfile)] } },
};

// The response waits until a test calls `window.__releaseProfile()`, so the test decides when the mount reports.
export const WarningHeld = {
  parameters: {
    mokapi: { test: 'warning' },
    msw: {
      handlers: [http.get('/api/profile', async () => {
        await new Promise<void>((resolve) => { (window as { __releaseProfile?: () => void }).__releaseProfile = resolve; });
        return HttpResponse.json(jane);
      })],
    },
  },
};

// Like an app with a data cache that lives as long as the page: the first mount requests the profile, later mounts
// of the story find it in the cache, so MSW sees no request and the mount validates nothing.
let cachedName: Promise<string> | undefined;
function CachedProfile() {
  const [name, setName] = useState('Loading...');
  useEffect(() => {
    cachedName ??= fetch('/api/profile').then(async (response) => (await response.json()).name);
    void cachedName.then(setName);
  }, []);
  return <p data-testid="profile">{name}</p>;
}

export const WarningCached = {
  render: () => <CachedProfile />,
  parameters: { mokapi: { test: 'warning' }, msw: { handlers: [profileHandler(invalidProfile)] } },
};

export const OffInvalid = {
  parameters: { mokapi: { test: 'off' }, msw: { handlers: [profileHandler(invalidProfile)] } },
};

// A story whose configuration changes while Storybook keeps running, as after editing the story file with HMR. The
// parameters come from the preview's own URL (`?mokapi=disable` or `?mokapi=off`) when the module is evaluated, so a
// scenario can reload only the preview iframe and keep the manager's state.
const reconfiguration = new URLSearchParams(location.search).get('mokapi');
const reconfiguredMokapi = reconfiguration === 'disable' ? { disable: true } : { test: reconfiguration === 'off' ? 'off' : 'warning' };

export const Reconfigurable = {
  parameters: { mokapi: reconfiguredMokapi, msw: { handlers: [profileHandler(invalidProfile)] } },
};

// A valid response and a request the contract does not know: neither counts as failing.
export const ErrorValid = {
  render: () => (
    <>
      <Profile />
      <Profile path="/api/settings" />
    </>
  ),
  parameters: {
    mokapi: { test: 'error' },
    msw: { handlers: [profileHandler(jane), profileHandler({ name: 'Settings' }, '/api/settings')] },
  },
};

// One valid and one invalid response, for the counts in the panel.
export const ErrorMixed = {
  render: () => (
    <>
      <Profile />
      <Profile path="/api/users/42" />
    </>
  ),
  parameters: { mokapi: { test: 'error' }, msw: { handlers: [profileHandler(invalidProfile), userHandler] } },
};

export const ErrorUnknownApi = {
  parameters: { mokapi: { api: 'Unknown API', test: 'error' }, msw: { handlers: [profileHandler(jane)] } },
};

export const ErrorNoWorker = {
  loaders: [(context: { msw?: unknown }) => { delete context.msw; }],
  parameters: { mokapi: { test: 'error' }, msw: { handlers: [profileHandler(jane)] } },
};

export const ErrorNoRequest = {
  render: () => <p data-testid="profile">No request</p>,
  parameters: { mokapi: { test: 'error' } },
};

// The response comes after 1 s and is invalid: the story fails only if the hook waits for it.
export const ErrorDelayed = {
  parameters: {
    mokapi: { test: 'error' },
    msw: {
      handlers: [http.get('/api/profile', async () => {
        await delay(1000);
        return HttpResponse.json(invalidProfile);
      })],
    },
  },
};

export const ErrorNeverAnswers = {
  parameters: {
    mokapi: { test: 'error' },
    msw: {
      handlers: [http.get('/api/profile', async () => {
        await delay('infinite');
        return HttpResponse.json(jane);
      })],
    },
  },
};

// A loading skeleton story: the handler is held on purpose, so the limit (`timeout`) ends the wait.
export const ErrorShortTimeout = {
  parameters: {
    mokapi: { test: 'error', timeout: 1500 },
    msw: {
      handlers: [http.get('/api/profile', async () => {
        await delay('infinite');
        return HttpResponse.json(jane);
      })],
    },
  },
};

// The handler is slower than the default limit of 4 s, `timeout` raises it. The response is invalid, so the
// story fails with the contract error and not with a timeout.
export const ErrorSlowHandler = {
  parameters: {
    mokapi: { test: 'error', timeout: 10000 },
    msw: {
      handlers: [http.get('/api/profile', async () => {
        await delay(6000);
        return HttpResponse.json(invalidProfile);
      })],
    },
  },
};

// The response arrives at once. The scenario holds Mokapi's answer back, so the limit is reached with a response
// that MSW delivered and Mokapi has not judged.
export const ErrorMokapiTooSlow = {
  parameters: { mokapi: { test: 'error', timeout: 1500 }, msw: { handlers: [profileHandler(jane)] } },
};

// One request is passed through by a handler, the other has no handler at all.
export const ErrorBypass = {
  render: () => (
    <>
      <Profile />
      <Profile path="/api/unhandled" />
    </>
  ),
  parameters: { mokapi: { test: 'error' }, msw: { handlers: [http.get('/api/profile', () => passthrough())] } },
};

export const ErrorHandlerThrows = {
  parameters: {
    mokapi: { test: 'error' },
    msw: { handlers: [http.get('/api/profile', () => { throw new Error('handler failed'); })] },
  },
};

export const InvalidTestParameter = {
  parameters: { mokapi: { test: 'strict' }, msw: { handlers: [profileHandler(jane)] } },
};

export const InvalidTimeoutParameter = {
  parameters: { mokapi: { timeout: 'long' }, msw: { handlers: [profileHandler(jane)] } },
};

export const ErrorDisabled = {
  parameters: { mokapi: { disable: true, test: 'error' }, msw: { handlers: [profileHandler(invalidProfile)] } },
};
