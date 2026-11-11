import { useEffect, useState } from 'react';

interface ProfileProps {
  path?: string;
  method?: 'GET' | 'POST';
  body?: unknown;
}

export function Profile({ path = '/api/profile', method = 'GET', body }: ProfileProps) {
  const [text, setText] = useState('Loading...');

  // Compared by content: Storybook hands out a new args object on every render.
  const payload = JSON.stringify(body);

  useEffect(() => {
    const init = method === 'POST'
      ? { method, headers: { 'Content-Type': 'application/json' }, body: payload }
      : { method };
    void fetch(path, init).then(async (response) => {
      setText(response.ok ? (await response.json()).name : `HTTP ${response.status}`);
    }).catch(() => setText('Failed'));
  }, [path, method, payload]);

  return <p data-testid="profile">{text}</p>;
}
