import { installPreviewMockBackendSync } from './mock-backend-sync.js';
import type { RuntimeOptions } from './types.js';

declare const __MOKAPI_STORYBOOK_OPTIONS__: RuntimeOptions | undefined;

export const settings: RuntimeOptions | undefined =
  typeof __MOKAPI_STORYBOOK_OPTIONS__ === 'undefined' ? undefined : __MOKAPI_STORYBOOK_OPTIONS__;

const synchronization = typeof window === 'undefined'
  ? { ready: Promise.resolve(), dispose() {} }
  : installPreviewMockBackendSync(window);

export const mockBackendReady = synchronization.ready;

if (import.meta.hot) {
  import.meta.hot.dispose(() => synchronization.dispose());
}
