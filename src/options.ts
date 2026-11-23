import type { MokapiAddonOptions, ResolvedAddonOptions, TestMode } from './types.js';

const TEST_MODES: readonly unknown[] = ['error', 'warning', 'off'];

/** How long afterEach waits for the validations of a story, unless `defaultTimeout` or `parameters.mokapi.timeout` say otherwise. */
export const DEFAULT_TIMEOUT_MS = 4000;

// Finite, because `setTimeout` overflows with Infinity and fires at once.
export const isPositiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

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
  const { dashboardUrl = 'http://localhost:8080', defaultValidation = false, defaultTest = 'warning', defaultPartial = false, defaultTimeout = DEFAULT_TIMEOUT_MS } = options;
  if (typeof dashboardUrl !== 'string' || !isHttpUrl(dashboardUrl)) {
    throw new Error('Mokapi: dashboardUrl must be an HTTP(S) URL.');
  }
  if (typeof defaultValidation !== 'boolean') {
    throw new Error('Mokapi: defaultValidation must be true or false.');
  }
  if (!isTestMode(defaultTest)) {
    throw new Error("Mokapi: defaultTest must be 'error', 'warning' or 'off'.");
  }
  if (typeof defaultPartial !== 'boolean') {
    throw new Error('Mokapi: defaultPartial must be true or false.');
  }
  if (!isPositiveNumber(defaultTimeout)) {
    throw new Error('Mokapi: defaultTimeout must be a positive number.');
  }
  return { dashboardUrl: dashboardUrl.replace(/\/+$/, ''), defaultValidation, defaultTest, defaultPartial, defaultTimeout };
}
