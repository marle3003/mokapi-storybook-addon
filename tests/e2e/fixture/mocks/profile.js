import { http, HttpResponse } from 'msw';
import { register } from 'mokapi-msw-adapter/register';

// Shared by Storybook (real msw) and Mokapi (alias msw -> mokapi-msw-adapter).
export const scenarios = {
  success: [http.get('/api/profile', () => {
    console.log('profile mock: success');
    return HttpResponse.json({ name: 'Jane Doe', email: 'jane.doe@example.com' });
  })],
  error: [http.get('/api/profile', () => HttpResponse.json({ message: 'Internal error' }, { status: 500 }))],
  invalid: [http.get('/api/profile', () => HttpResponse.json({ name: 'Jane Doe' }))], // email missing
};

export default function () {
  register(scenarios, { api: 'Profile API' });
}
