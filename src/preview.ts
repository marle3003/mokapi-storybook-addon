import { settings } from './runtime.js';

export const globalTypes = {
  mockBackend: {
    description: 'Execute shared mocks in MSW or validate them with Mokapi',
    toolbar: {
      icon: 'globe',
      dynamicTitle: true,
      items: [
        { value: 'msw', title: 'MSW (browser)' },
        { value: 'mokapi', title: 'Mokapi (OpenAPI validation)' },
      ],
    },
  },
};

export const initialGlobals = { mockBackend: settings?.defaultBackend ?? 'msw' };
