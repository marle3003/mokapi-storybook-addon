import type { MokapiAddonOptions, ResolvedAddonOptions, TestMode } from './types.js';

const TEST_MODES: readonly unknown[] = ['error', 'todo', 'off'];

export const isTestMode = (value: unknown): value is TestMode => TEST_MODES.includes(value);

function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Storybook passes the addon options untyped, so every option is checked.
export function resolveOptions(options: Partial<MokapiAddonOptions> = {}): ResolvedAddonOptions {
  const { dashboardUrl = 'http://localhost:8080', defaultValidation = false, defaultTest = 'todo' } = options;
  if (typeof dashboardUrl !== 'string' || !isHttpUrl(dashboardUrl)) {
    throw new Error('Mokapi: dashboardUrl must be an HTTP(S) URL.');
  }
  if (typeof defaultValidation !== 'boolean') {
    throw new Error('Mokapi: defaultValidation must be true or false.');
  }
  if (!isTestMode(defaultTest)) {
    throw new Error("Mokapi: defaultTest must be 'error', 'todo' or 'off'.");
  }
  return { dashboardUrl: dashboardUrl.replace(/\/+$/, ''), defaultValidation, defaultTest };
}
