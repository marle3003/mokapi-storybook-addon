import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';

const configDir = fileURLToPath(new URL('./.storybook', import.meta.url));

// The e2e test sets MOKAPI_VITEST_TEST to prove that `initialGlobals` overrides `defaultTest` in a Vitest run.
const initialGlobals = process.env.MOKAPI_VITEST_TEST
  ? { mokapiValidation: 'on', mokapiTest: process.env.MOKAPI_VITEST_TEST }
  : undefined;

// Vitest's default testTimeout (5 s) stays on purpose: the addon's own 4 s limit must fit into it.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        plugins: [storybookTest({ configDir, initialGlobals })],
        test: {
          name: 'storybook',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
