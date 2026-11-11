// The README screenshot shows neither the test mode stories nor the addon-vitest widget.
const screenshot = process.env.MOKAPI_SCREENSHOT === 'true';

export default {
  framework: '@storybook/react-vite',
  stories: screenshot ? ['../Profile.stories.tsx', '../Docs.stories.tsx'] : ['../*.stories.tsx'],
  // Replaces `npx msw init` from the README. A directory, because addon-vitest's dev server cannot serve a single file.
  staticDirs: [
    { from: '../../../../node_modules/msw/lib', to: '/' },
  ],
  addons: [
    '@storybook/addon-docs',
    ...(screenshot ? [] : ['@storybook/addon-vitest']),
    {
      name: 'mokapi-storybook-addon',
      options: {
        dashboardUrl: process.env.MOKAPI_DASHBOARD,
        defaultValidation: process.env.MOKAPI_DEFAULT_VALIDATION === 'true',
        defaultTest: process.env.MOKAPI_DEFAULT_TEST,
      },
    },
  ],
};
