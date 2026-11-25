import { http, HttpResponse, type JsonBodyType } from 'msw';

export const customer = { firstName: 'Jane', lastName: 'Doe' };

export const order = {
  id: 1,
  status: 'in_transit',
  customer,
  items: [
    { name: 'Espresso machine', quantity: 1, price: 249.9 },
    { name: 'Descaling tablets', quantity: 2, price: 7.5 },
  ],
  currency: 'CHF',
};

// Handler factories, as projects share them between stories and tests.
export const ordersHandler = (body: JsonBodyType) =>
  http.get('/orders', () => HttpResponse.json(body));

export const orderHandler = (body: JsonBodyType, path = '/orders/:id') =>
  http.get(path, () => HttpResponse.json(body));

export const notFoundHandler = (body: JsonBodyType) =>
  http.get('/orders/:id', () =>
    HttpResponse.json(body, { status: 404, headers: { 'Content-Type': 'application/problem+json' } }));

export const createOrderHandler = http.post('/orders', () => HttpResponse.json(order, { status: 201 }));
