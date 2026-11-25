import { delay, http, HttpResponse } from 'msw';
import { Profile } from './Profile';

// Its own title, so it has its own autodocs page (docs-remembered--docs).
// Both stories render in their own iframe (`docs.story.inline: false`), so each counts its renderIds from 1.
export default { title: 'Docs Remembered', component: Profile, tags: ['autodocs'] };

// The contract requires `email`. The answer is slow, so the other story has started and reported before this one reports.
export const Invalid = {
  parameters: {
    mokapi: { test: 'warning' },
    msw: { handlers: [http.get('/api/profile', async () => {
      await delay(2500);
      return HttpResponse.json({ name: 'Jane Doe' });
    })] },
  },
};

// Sends no request. The loader makes it start after the other story, so that its render starts second.
export const NoRequest = {
  loaders: [() => new Promise<void>((resolve) => { setTimeout(resolve, 1000); })],
  render: () => <p data-testid="profile">No request</p>,
  parameters: { mokapi: { test: 'warning' } },
};
