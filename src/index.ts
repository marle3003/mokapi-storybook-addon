import { MokapiStoryParameters } from './types.js';

export { resolveOptions } from './options.js';
export type {
  ManagerPanelOptions,
  MokapiAddonOptions,
  MokapiEvent,
  MokapiEventAction,
  MokapiEventPage,
  MokapiEventRequest,
  MokapiEventResponse,
  MokapiRoute,
  MokapiRouteDefinition,
  MokapiStoryParameters,
  MockBackend,
  ResolvedAddonOptions,
  RuntimeOptions,
  SerializedMethod,
} from './types.js';

declare module 'storybook/internal/csf' {
  interface Parameters {
    mokapi?: MokapiStoryParameters;
  }
}
