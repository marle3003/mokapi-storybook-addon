import { http, HttpResponse } from 'msw';
import { Profile } from './Profile';

// Its own title, so it has its own autodocs page (docs-test-mode--docs). Left out when MOKAPI_SCREENSHOT is set.
// The story renders in its own iframe because the preview sets `docs.story.inline: false`.
export default { title: 'Docs Test Mode', component: Profile, tags: ['autodocs'] };

// The contract requires `email`.
export const ErrorInvalid = {
  parameters: {
    mokapi: { test: 'error' },
    msw: { handlers: [http.get('/api/profile', () => HttpResponse.json({ name: 'Jane Doe' }))] },
  },
};
