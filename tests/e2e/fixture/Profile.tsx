import { useEffect, useState } from 'react';

interface ProfileProps {
  path?: string;
  method?: 'GET' | 'POST';
  body?: unknown;
}

export function Profile({ path = '/api/profile', method = 'GET', body }: ProfileProps) {
  const [text, setText] = useState('Loading...');

  useEffect(() => {
    const init = method === 'POST'
      ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method };
    void fetch(path, init).then(async (response) => {
      setText(response.ok ? (await response.json()).name : `HTTP ${response.status}`);
    }).catch(() => setText('Failed'));
  }, [path, method, body]);

  return <p data-testid="profile">{text}</p>;
}
