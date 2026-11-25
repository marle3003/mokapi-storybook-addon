import { setupWorker } from 'msw/browser';
import { mswLoader } from 'msw-storybook-addon/csf3';

export default {
  loaders: [mswLoader(async () => {
    const worker = setupWorker();
    await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
    return worker;
  })],
  parameters: {
    layout: 'fullscreen',
    mokapi: { api: 'Shop API' },
    // Keeps the Mokapi tab in view in the images: the other panels are not needed here.
    controls: { disable: true },
    actions: { disable: true },
    interactions: { disable: true },
  },
};
