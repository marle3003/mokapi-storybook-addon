import { http, HttpResponse, passthrough } from 'msw';
import { jane, profileHandler } from './handlers';
import { Profile } from './Profile';


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

// A finite CSS animation keeps the render in `completing` (waitForAnimations), where Storybook does not
// enqueue a re-render but starts it at once. It runs longer than waitForAnimations' 5 s timeout, so each
// render leaves `completing` on its own timeout: the old render before the re-render.
export const Animated = {
  render: () => (
    <>
      <style>{'@keyframes fade { from { opacity: 0.5; } to { opacity: 1; } }'}</style>
      <div style={{ animation: 'fade 8s' }}>
        <Profile />
      </div>
    </>
  ),
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
