import type { MokapiAddonOptions, ResolvedAddonOptions } from './types.js';

function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Storybook passes the addon options untyped, so every option is checked.
export function resolveOptions(options: Partial<MokapiAddonOptions> = {}): ResolvedAddonOptions {
  const { dashboardUrl = 'http://localhost:8080', defaultValidation = false } = options;
  if (typeof dashboardUrl !== 'string' || !isHttpUrl(dashboardUrl)) {
    throw new Error('Mokapi: dashboardUrl must be an HTTP(S) URL.');
  }
  if (typeof defaultValidation !== 'boolean') {
    throw new Error('Mokapi: defaultValidation must be true or false.');
  }
  return { dashboardUrl: dashboardUrl.replace(/\/+$/, ''), defaultValidation };
}
