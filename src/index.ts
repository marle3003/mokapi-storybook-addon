import { MokapiStoryParameters } from './types.js';

export { resolveOptions } from './options.js';
export type { MokapiAddonOptions, MokapiStoryParameters, ResolvedAddonOptions, TestMode } from './types.js';

declare module 'storybook/internal/csf' {
  interface Parameters {
    mokapi?: MokapiStoryParameters;
  }
}
