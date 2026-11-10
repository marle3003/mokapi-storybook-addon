export default {
  framework: '@storybook/react-vite',
  stories: ['../*.stories.tsx'],
  // Replaces `npx msw init` from the README.
  staticDirs: [
    { from: '../../../../node_modules/msw/lib/mockServiceWorker.js', to: '/mockServiceWorker.js' },
  ],
  addons: [
    '@storybook/addon-docs',
    {
      name: 'mokapi-storybook-addon',
      options: {
        dashboardUrl: process.env.MOKAPI_DASHBOARD,
        defaultValidation: process.env.MOKAPI_DEFAULT_VALIDATION === 'true',
      },
    },
  ],
};
