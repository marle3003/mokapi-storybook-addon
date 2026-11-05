import { useEffect, useState } from 'react';

export function Profile() {
  const [text, setText] = useState('Loading...');

  useEffect(() => {
    void fetch('/api/profile').then(async (response) => {
      setText(response.ok ? (await response.json()).name : `HTTP ${response.status}`);
    });
  }, []);

  return <p data-testid="profile">{text}</p>;
}
