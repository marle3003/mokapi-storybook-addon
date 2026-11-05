import type { MockBackend } from './types.js';

export const PREVIEW_READY = 'mokapi/backend-ready';
export const MOCK_BACKEND_CHANGED = 'mokapi/backend-changed';

const MOCK_BACKEND_PREFIX = 'mockBackend:';
const HANDSHAKE_TIMEOUT_MS = 10000;

export function isMockBackend(value: unknown): value is MockBackend {
  return value === 'msw' || value === 'mokapi';
}

function urlGlobals(url: URL): string[] {
  return (url.searchParams.get('globals') ?? '').split(';');
}

export function initialMockBackend(href: string, fallback: MockBackend): MockBackend {
  const entry = urlGlobals(new URL(href)).find((value) => value.startsWith(MOCK_BACKEND_PREFIX));
  const mockBackend = entry?.slice(MOCK_BACKEND_PREFIX.length);
  return isMockBackend(mockBackend) ? mockBackend : fallback;
}

export function mockBackendUrl(href: string, mockBackend: MockBackend): string {
  const url = new URL(href);
  const globals = urlGlobals(url)
    .filter((entry) => entry && !entry.startsWith(MOCK_BACKEND_PREFIX));
  globals.push(`${MOCK_BACKEND_PREFIX}${mockBackend}`);
  url.searchParams.set('globals', globals.join(';'));
  return url.href;
}

function isPreviewWindow(source: MessageEventSource | null, managerWindow: Window): source is Window {
  return source !== null &&
    'top' in source &&
    'location' in source &&
    source !== managerWindow &&
    source.top === managerWindow &&
    source.location.origin === managerWindow.location.origin &&
    source.location.pathname.endsWith('/iframe.html');
}

export function installManagerMockBackendSync(
  managerWindow: Window,
  getMockBackend: () => MockBackend,
): { update(mockBackend: unknown): void; dispose(): void } {
  const previews = new Set<Window>();
  const sendMockBackend = (preview: Window, mockBackend: MockBackend): void => {
    preview.postMessage(
      { type: MOCK_BACKEND_CHANGED, backend: mockBackend },
      managerWindow.location.origin,
    );
  };
  const onPreviewReady = (event: MessageEvent<unknown>): void => {
    if (event.origin !== managerWindow.location.origin || !isPreviewWindow(event.source, managerWindow)) return;

    previews.add(event.source);
    sendMockBackend(event.source, getMockBackend());
  };
  managerWindow.addEventListener('message', onPreviewReady);

  return {
    update(mockBackend: unknown): void {
      if (!isMockBackend(mockBackend)) return;
      for (const preview of previews) {
        if (preview.closed) {
          previews.delete(preview);
        } else {
          sendMockBackend(preview, mockBackend);
        }
      }
    },
    dispose(): void {
      managerWindow.removeEventListener('message', onPreviewReady);
      previews.clear();
    },
  };
}

export function installPreviewMockBackendSync(
  previewWindow: Window,
): { ready: Promise<void>; dispose(): void } {
  const managerWindow = previewWindow.top;
  if (!managerWindow || managerWindow === previewWindow ||
    !previewWindow.location.pathname.endsWith('/iframe.html')) {
    return { ready: Promise.resolve(), dispose() {} };
  }
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let currentMockBackend: MockBackend | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch((error: unknown) => {
    const previewConsole = 'console' in previewWindow
      ? (previewWindow as Window & { console?: Console }).console ?? globalThis.console
      : globalThis.console;
    previewConsole.error(error);
  });
  const handshakeTimer = previewWindow.setTimeout(() => {
    rejectReady?.(new Error('Mokapi: backend synchronization timed out. Reload Storybook.'));
  }, HANDSHAKE_TIMEOUT_MS);

  const onMockBackendChanged = (event: MessageEvent<unknown>): void => {
    if (event.origin !== previewWindow.location.origin || event.source !== managerWindow) return;
    if (typeof event.data !== 'object' || event.data === null ||
      !('type' in event.data) || event.data.type !== MOCK_BACKEND_CHANGED ||
      !('backend' in event.data) || !isMockBackend(event.data.backend)) return;

    const mockBackend = event.data.backend;
    previewWindow.clearTimeout(handshakeTimer);
    const url = mockBackendUrl(previewWindow.location.href, mockBackend);
    if (url !== previewWindow.location.href && currentMockBackend !== mockBackend) {
      previewWindow.location.replace(url);
      return;
    }
    currentMockBackend = mockBackend;
    resolveReady?.();
  };
  previewWindow.addEventListener('message', onMockBackendChanged);
  managerWindow.postMessage({ type: PREVIEW_READY }, previewWindow.location.origin);

  return {
    ready,
    dispose(): void {
      previewWindow.clearTimeout(handshakeTimer);
      previewWindow.removeEventListener('message', onMockBackendChanged);
    },
  };
}
