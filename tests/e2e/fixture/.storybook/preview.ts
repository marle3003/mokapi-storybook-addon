import { setupWorker } from 'msw/browser';
import { mswLoader } from 'msw-storybook-addon/csf3';

export default {
  loaders: [mswLoader(async () => {
    const worker = setupWorker();
    await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
    return worker;
  })],
  parameters: {
    mokapi: { api: 'Profile API' },
    docs: { story: { inline: false, iframeHeight: '300px' } },
  },
};
