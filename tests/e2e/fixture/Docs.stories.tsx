import { http, HttpResponse } from 'msw';
import { Profile } from './Profile';

export default { title: 'Docs', component: Profile, tags: ['autodocs'] };

export const Valid = {
  parameters: {
    msw: {
      handlers: [http.get('/api/profile', () => HttpResponse.json({ name: 'Jane Doe', email: 'jane@example.com' }))],
    },
  },
};
