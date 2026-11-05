import { setupWorker } from 'msw/browser';
import { mswLoader } from 'msw-storybook-addon/csf3';
import { createMokapiLoader } from 'mokapi-storybook-addon/msw';

const loadMsw = mswLoader(async () => {
  const worker = setupWorker();
  await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
  return worker;
});

export default {
  loaders: [createMokapiLoader(loadMsw)],
  parameters: { docs: { story: { inline: false, iframeHeight: '300px' } } },
};
