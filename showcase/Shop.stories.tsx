import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import { createOrderHandler, notFoundHandler, order, orderHandler, ordersHandler } from './handlers';
import { OrderDetail, OrderForm, OrderList, OrderOverview, Shop } from './Shop';

const meta = {
  title: 'Orders',
  decorators: [(Story) => <Shop><Story /></Shop>],
} satisfies Meta;
export default meta;

type Story = StoryObj<typeof meta>;

export const Valid: Story = {
  render: () => <OrderDetail path="/orders/1" />,
  parameters: { msw: { handlers: [orderHandler(order)] } },
};

// The contract moved `name` to `firstName` and `lastName`, the mock didn't.
export const RenamedField: Story = {
  render: () => <OrderDetail path="/orders/1" />,
  parameters: { msw: { handlers: [orderHandler({ ...order, customer: { name: 'Jane Doe' } })] } },
};

// The contract wraps the list in `{ items, total }`, the mock returns a bare array.
export const PaginatedList: Story = {
  render: () => <OrderList />,
  parameters: { msw: { handlers: [ordersHandler([order])] } },
};

// The backend started to send a status the contract doesn't know.
export const EnumChanged: Story = {
  render: () => <OrderDetail path="/orders/1" />,
  parameters: { msw: { handlers: [orderHandler({ ...order, status: 'shipped' })] } },
};

// The form sends `quantity` as a string and no `currency`. The play function submits it.
export const RequestBug: Story = {
  render: () => <OrderForm />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Place order' }));
  },
  parameters: { msw: { handlers: [createOrderHandler] } },
};

// The contract describes the 404 as `application/problem+json` with `title` and `detail`.
export const ErrorState: Story = {
  render: () => <OrderDetail path="/orders/999" />,
  parameters: { msw: { handlers: [notFoundHandler({ message: 'Order not found' })] } },
};

export const Partial: Story = {
  render: () => <OrderDetail path="/orders/1" />,
  parameters: {
    mokapi: { partial: true },
    msw: { handlers: [orderHandler({ id: 1, status: 'in_transit' })] },
  },
};

// Three requests: a valid order, an order with an unknown status and a path of an older API version.
export const OrderPage: Story = {
  render: () => <OrderOverview />,
  parameters: {
    msw: {
      handlers: [
        orderHandler(order, '/orders/1'),
        orderHandler({ ...order, id: 2, status: 'shipped' }, '/orders/2'),
        orderHandler(order, '/v1/orders/1'),
      ],
    },
  },
};
