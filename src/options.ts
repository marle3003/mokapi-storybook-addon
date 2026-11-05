import type { MokapiAddonOptions, ResolvedAddonOptions } from './types.js';

function validateHttpUrl(value: string, name: string): void {
  if (!/^https?:$/.test(new URL(value).protocol)) {
    throw new Error(`Mokapi: ${name} must be an HTTP(S) URL.`);
  }
}

// Storybook passes the addon options untyped, so every option, including target, is checked.
export function resolveOptions(options: Partial<MokapiAddonOptions> = {}): ResolvedAddonOptions {
  if (typeof options.target !== 'string' || !options.target) {
    throw new Error('Mokapi: target is required. Set it to the URL of your API in Mokapi.');
  }
  const resolved: ResolvedAddonOptions = {
    dashboardUrl: 'http://localhost:8080',
    proxyPath: '/mokapi',
    defaultBackend: 'msw',
    scenarioParameter: '__mockScenario',
    ...options,
    target: options.target,
  };
  if (resolved.defaultBackend !== 'msw' && resolved.defaultBackend !== 'mokapi') {
    throw new Error('Mokapi: defaultBackend must be msw or mokapi.');
  }
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(resolved.proxyPath) || resolved.proxyPath.endsWith('/')) {
    throw new Error('Mokapi: proxyPath must be an absolute path without a trailing slash.');
  }
  if (typeof resolved.scenarioParameter !== 'string' || !resolved.scenarioParameter.trim()) {
    throw new Error('Mokapi: scenarioParameter must not be empty.');
  }
  validateHttpUrl(resolved.target, 'target');
  validateHttpUrl(resolved.dashboardUrl, 'dashboardUrl');
  return resolved;
}
