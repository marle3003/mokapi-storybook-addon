import { http, HttpResponse } from 'msw';

// A handler factory, as projects share them between stories and tests.
export const profileHandler = (profile: object, path = '/api/profile') =>
  http.get(path, () => HttpResponse.json(profile));

export const jane = { name: 'Jane Doe', email: 'jane@example.com' };

// Matches the contract path `/api/users/{id}`.
export const userHandler = http.get('/api/users/:id', () => HttpResponse.json(jane));
