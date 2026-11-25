// Process helpers shared by tests/e2e.mjs and scripts/screenshot.mjs.
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';

const require = createRequire(import.meta.url);

// Returns count distinct free ports. All servers stay open until every port is
// allocated, otherwise the OS may hand out the same port twice.
export async function unusedPorts(count) {
  const servers = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.filter((server) => server.listening).map((server) =>
      new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  }
}

// MOKAPI_BIN overrides the go-mokapi binary, e.g. for a local Mokapi build.
export function mokapiBinary() {
  if (process.env.MOKAPI_BIN) return process.env.MOKAPI_BIN;
  const mokapiRequire = createRequire(require.resolve('go-mokapi/package.json'));
  return mokapiRequire(`@go-mokapi/${process.platform}-${process.arch}`);
}

export const STOP_GRACE_MS = 5000;

// SIGTERM, then SIGKILL after the grace period. The timer is cancelled when the process exits,
// so it doesn't keep the event loop alive. SIGKILL is sent in any case, because a Storybook
// leader can exit on SIGTERM while other processes of its group still hold the port.
export async function stopProcess(stopped, kill) {
  kill('SIGTERM');
  const grace = new AbortController();
  await Promise.race([stopped, setTimeout(STOP_GRACE_MS, undefined, { signal: grace.signal })]);
  grace.abort();
  kill('SIGKILL');
  await stopped;
}
