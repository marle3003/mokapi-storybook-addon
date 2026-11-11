import { setupWorker } from 'msw/browser';
import { mswLoader } from 'msw-storybook-addon/csf3';

export default {
  loaders: [mswLoader(async () => {
    const worker = setupWorker();
    await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
    // TODO(bug-storybook-remount-while-pending): diagnostics, remove after the analysis.
    worker.events.on('request:start', ({ request, requestId }) => console.debug(`[msw request:start] ${requestId} ${request.method} ${request.url}`));
    worker.events.on('response:mocked', ({ request, requestId }) => console.debug(`[msw response:mocked] ${requestId} ${request.method} ${request.url}`));
    return worker;
  })],
  beforeEach: (context: { id: string; globals: Record<string, unknown> }) => {
    console.debug(`[render] ${context.id} validation=${context.globals.mokapiValidation}`);
  },
  parameters: {
    mokapi: { api: 'Profile API' },
    docs: { story: { inline: false, iframeHeight: '300px' } },
  },
};
