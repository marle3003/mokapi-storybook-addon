import { http, HttpResponse, passthrough } from 'msw';
import { Profile } from './Profile';

// A handler factory, as projects share them between stories and tests.
const profileHandler = (profile: object, path = '/api/profile') =>
  http.get(path, () => HttpResponse.json(profile));

const jane = { name: 'Jane Doe', email: 'jane@example.com' };

export default { title: 'Profile', component: Profile };

export const Valid = { parameters: { msw: { handlers: [profileHandler(jane)] } } };

// The contract requires `email`.
export const Invalid = { parameters: { msw: { handlers: [profileHandler({ name: 'Jane Doe' })] } } };

export const PathPattern = {
  args: { path: '/api/users/42' },
  parameters: { msw: { handlers: [http.get('/api/users/:id', () => HttpResponse.json(jane))] } },
};

export const NotInContract = {
  args: { path: '/api/settings' },
  parameters: { msw: { handlers: [profileHandler({ name: 'Settings' }, '/api/settings')] } },
};

export const PostValid = {
  args: { method: 'POST', body: jane },
  parameters: { msw: { handlers: [http.post('/api/profile', () => HttpResponse.json(jane))] } },
};

// The request body misses the required `name`.
export const PostInvalidBody = {
  args: { method: 'POST', body: { email: 'jane@example.com' } },
  parameters: { msw: { handlers: [http.post('/api/profile', () => HttpResponse.json(jane))] } },
};

// The render is still pending (afterEach) when validation is switched on, so Storybook enqueues the re-render.
export const SlowAfterEach = {
  afterEach: () => new Promise((resolve) => setTimeout(resolve, 3000)),
  parameters: { msw: { handlers: [profileHandler(jane)] } },
};

export const Passthrough = {
  parameters: { msw: { handlers: [http.get('/api/profile', () => passthrough())] } },
};

export const Disabled = {
  parameters: { mokapi: { disable: true }, msw: { handlers: [profileHandler(jane)] } },
};

export const UnknownApi = {
  parameters: { mokapi: { api: 'Unknown API' }, msw: { handlers: [profileHandler(jane)] } },
};

// Loaders of a story run after the project's mswLoader, so this story has no worker.
export const WithoutWorker = {
  loaders: [(context: { msw?: unknown }) => { delete context.msw; }],
  parameters: { msw: { handlers: [profileHandler(jane)] } },
};
