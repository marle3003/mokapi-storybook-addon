import { addons } from 'storybook/preview-api';
import { validationHook, type HookContext } from './listener.js';
import { resolveOptions } from './options.js';
import { PANEL_EVENT, type PanelAction } from './results.js';
import type { ResolvedAddonOptions } from './types.js';

// Defined by the preset's viteFinal; the preview annotation only exists with the preset.
declare const __MOKAPI_STORYBOOK_OPTIONS__: ResolvedAddonOptions | undefined;

const options = resolveOptions(typeof __MOKAPI_STORYBOOK_OPTIONS__ === 'undefined' ? undefined : __MOKAPI_STORYBOOK_OPTIONS__);

export const globalTypes = {
  mokapiValidation: {
    description: 'Validate with Mokapi',
    toolbar: {
      icon: 'check',
      dynamicTitle: true,
      items: [
        { value: 'on', title: 'Mokapi validation on' },
        { value: 'off', title: 'Mokapi validation off' },
      ],
    },
  },
};

export const initialGlobals = { mokapiValidation: options.defaultValidation ? 'on' : 'off' };

// Storybook runs beforeEach after all loaders, so `context.msw` is set by then.
export const beforeEach = (context: HookContext): void => {
  validationHook(context, {
    emit: (action: PanelAction) => addons.getChannel().emit(PANEL_EVENT, action),
    dashboardUrl: options.dashboardUrl,
  });
};
