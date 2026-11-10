import { addons } from 'storybook/preview-api';
import { validationHook, type HookContext } from './listener.js';
import { resolveOptions } from './options.js';
import { PANEL_EVENT, type PanelAction } from './results.js';
import type { ResolvedAddonOptions } from './types.js';

// Defined by the preset's viteFinal; the preview annotation only exists with the preset.
declare const __MOKAPI_STORYBOOK_OPTIONS__: ResolvedAddonOptions | undefined;

const options = resolveOptions(typeof __MOKAPI_STORYBOOK_OPTIONS__ === 'undefined' ? undefined : __MOKAPI_STORYBOOK_OPTIONS__);

// No `globalTypes`: Storybook would render its own dropdown for the global. The toggle is a manager tool,
// and `initialGlobals` is enough for `updateGlobals` and the URL to accept `mokapiValidation`.
export const initialGlobals = { mokapiValidation: options.defaultValidation ? 'on' : 'off' };

// Storybook runs beforeEach after all loaders, so `context.msw` is set by then.
export const beforeEach = (context: HookContext): void => {
  validationHook(context, {
    emit: (action: PanelAction) => addons.getChannel().emit(PANEL_EVENT, action),
    dashboardUrl: options.dashboardUrl,
  });
};
