import type { MokapiRoute, MokapiRouteDefinition, SerializedMethod } from './types.js';

export function forwardingUrl(
  requestUrl: string,
  base: string,
  scenarioParameter: string,
  scenario: string,
): URL {
  const source = new URL(requestUrl);
  const target = new URL(`${base.replace(/\/$/, '')}${source.pathname}`, source.origin);
  target.search = source.search;
  target.searchParams.set(scenarioParameter, scenario);
  return target;
}

export function validateRoute(definition: MokapiRouteDefinition): Required<MokapiRoute> {
  const route = typeof definition === 'string' ? { path: definition } : definition;
  const method = route.method ?? 'GET';
  if (typeof route.path !== 'string' || !/^\/[^:*?{}#]*$/.test(route.path)) {
    throw new Error('Mokapi: routes must use exact relative paths, without query or path patterns.');
  }

  return { method, path: route.path };
}

export function handlerMethod(method: SerializedMethod): string | RegExp {
  return typeof method === 'string' ? method : new RegExp(method.source, method.flags);
}

export function methodLabel(method: SerializedMethod): string {
  return typeof method === 'string' ? method : `/${method.source}/${method.flags}`;
}
