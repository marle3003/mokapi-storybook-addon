import { delay, http, HttpResponse, passthrough } from 'msw';
import { jane, profileHandler } from './handlers';
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

export const TodoInvalid = {
  parameters: { mokapi: { test: 'todo' }, msw: { handlers: [profileHandler(invalidProfile)] } },
};

export const OffInvalid = {
  parameters: { mokapi: { test: 'off' }, msw: { handlers: [profileHandler(invalidProfile)] } },
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

export const ErrorDisabled = {
  parameters: { mokapi: { disable: true, test: 'error' }, msw: { handlers: [profileHandler(invalidProfile)] } },
};
