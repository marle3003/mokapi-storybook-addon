import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

interface Order {
  id: number;
  status: string;
  customer?: { firstName?: string; lastName?: string };
  items?: { name: string; quantity: number; price: number }[];
  currency?: string;
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  in_transit: 'In transit',
  delivered: 'Delivered',
};

const styles = `
.shop { min-height: 100vh; box-sizing: border-box; padding: 24px 32px; font-family: system-ui, sans-serif; color: #1f2933; background: #f5f7fa; }
.shop-header { display: flex; align-items: baseline; gap: 24px; margin-bottom: 24px; }
.shop-header h1 { margin: 0; font-size: 20px; }
.shop-header nav { display: flex; gap: 16px; font-size: 14px; color: #52606d; }
.shop-card { background: #fff; border: 1px solid #d9e2ec; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
.shop-card h2 { margin: 0 0 12px; font-size: 16px; display: flex; align-items: center; justify-content: space-between; }
.shop-card p { margin: 4px 0; font-size: 14px; }
.shop-card table { width: 100%; border-collapse: collapse; font-size: 14px; }
.shop-card th, .shop-card td { padding: 6px 0; text-align: left; border-bottom: 1px solid #e4e7eb; }
.shop-card td:last-child, .shop-card th:last-child { text-align: right; }
.shop-badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; background: #e4e7eb; color: #323f4b; }
.shop-badge-pending { background: #fff3c4; color: #8d2b0b; }
.shop-badge-in_transit { background: #bae3ff; color: #05445f; }
.shop-badge-delivered { background: #c6f7e2; color: #05603a; }
.shop-error { color: #ba2525; }
.shop-card form { display: flex; align-items: end; gap: 12px; }
.shop-card label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.shop-card input { padding: 6px 8px; border: 1px solid #9aa5b1; border-radius: 4px; background: #fff; color: inherit; }
.shop-card button { padding: 7px 16px; border: 0; border-radius: 4px; background: #2680c2; color: #fff; font-weight: 600; cursor: pointer; }
@media (prefers-color-scheme: dark) {
  .shop { color: #e4e7eb; background: #1f2933; }
  .shop-header nav { color: #9aa5b1; }
  .shop-card { background: #323f4b; border-color: #52606d; }
  .shop-card th, .shop-card td { border-bottom-color: #52606d; }
  .shop-badge { background: #52606d; color: #f5f7fa; }
  .shop-badge-pending { background: #8d2b0b; color: #fff3c4; }
  .shop-badge-in_transit { background: #05445f; color: #bae3ff; }
  .shop-badge-delivered { background: #05603a; color: #c6f7e2; }
  .shop-error { color: #ff9b9b; }
  .shop-card input { background: #1f2933; border-color: #7b8794; }
}
`;

export function Shop({ children }: { children: ReactNode }) {
  return (
    <div className="shop">
      <style>{styles}</style>
      <header className="shop-header">
        <h1>Acme Shop</h1>
        <nav><span>Orders</span><span>Customers</span><span>Reports</span></nav>
      </header>
      {children}
    </div>
  );
}

// Loads a JSON resource and keeps what the component needs: the data or the text of the failure.
function useResource<T>(path: string, read: (response: Response) => Promise<T>) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    void fetch(path)
      .then(read)
      .then((data) => setState({ data }))
      .catch(() => setState({ error: 'Something went wrong' }));
  }, [path, read]);
  return state;
}

// The 404 answer of the contract is a problem with a `detail` text.
const readOrder = async (response: Response): Promise<{ order?: Order; problem?: string }> => {
  const body = await response.json();
  return response.ok ? { order: body } : { problem: body.detail ?? 'Something went wrong' };
};

// Sorted by id, as the list shows the newest order last.
const readOrders = async (response: Response): Promise<{ items: Order[]; total: number }> => {
  const { items, total } = await response.json();
  return { items: [...items].sort((a: Order, b: Order) => a.id - b.id), total };
};

function StatusBadge({ status }: { status: string }) {
  return <span className={`shop-badge shop-badge-${status}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function OrderList() {
  const { data, error } = useResource('/orders', readOrders);
  return (
    <section className="shop-card">
      <h2>Orders{data && <span>{data.total} in total</span>}</h2>
      {error && <p className="shop-error">{error}</p>}
      {data?.items.map((order) => (
        <p key={order.id}>#{order.id} <StatusBadge status={order.status} /></p>
      ))}
    </section>
  );
}

export function OrderDetail({ path }: { path: string }) {
  const { data, error } = useResource(path, readOrder);
  const order = data?.order;
  const name = [order?.customer?.firstName, order?.customer?.lastName].filter(Boolean).join(' ');
  return (
    <section className="shop-card">
      {(error ?? data?.problem) && <p className="shop-error">{error ?? data?.problem}</p>}
      {order && (
        <>
          <h2>Order #{order.id}<StatusBadge status={order.status} /></h2>
          <p>Customer: {name || 'unknown'}</p>
          <table>
            <thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
            <tbody>
              {order.items?.map((item) => (
                <tr key={item.name}><td>{item.name}</td><td>{item.quantity}</td><td>{item.price.toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

export function OrderForm() {
  const [placed, setPlaced] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const quantity = new FormData(event.currentTarget).get('quantity');
    // The input value is a string and the form never sends the currency.
    void fetch('/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 7, quantity }),
    }).then(() => setPlaced(true));
  };
  return (
    <section className="shop-card">
      <h2>New order</h2>
      <form onSubmit={submit}>
        <label>Quantity<input name="quantity" defaultValue="2" /></label>
        <button type="submit">Place order</button>
        {placed && <span>Order placed</span>}
      </form>
    </section>
  );
}

// Two orders on one page, one of them through a path of an older API version.
export function OrderOverview() {
  return (
    <>
      <OrderDetail path="/orders/1" />
      <OrderDetail path="/orders/2" />
      <OrderDetail path="/v1/orders/1" />
    </>
  );
}
