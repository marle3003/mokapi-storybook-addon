import { bypass, HttpHandler, HttpResponse } from 'msw';
import { forwardingUrl, handlerMethod, validateRoute } from './forwarding.js';
import { mockBackendReady, settings } from './runtime.js';
import type { MokapiStoryParameters } from './index.js';
import type { MokapiRouteDefinition, RuntimeOptions } from './types.js';

export { createStoryScenarios } from './scenarios.js';
export type { ScenarioOptions, ScenarioParameters } from './scenarios.js';

export interface MokapiLoaderParameters extends Record<string, unknown> {
  mokapi?: MokapiStoryParameters;
  msw?: unknown;
}

export interface MokapiLoaderContext {
  parameters: MokapiLoaderParameters;
  globals: Record<string, unknown> & { mockBackend?: unknown };
}

export type MokapiForwardingOptions = Pick<
  RuntimeOptions,
  'proxyPath' | 'scenarioParameter' | 'browserUrl'
>;

type LoaderFunction<Context, Result> = (context: Context) => Result;

function validateMokapiParameters(config: MokapiStoryParameters): void {
  if (typeof config.scenario !== 'string' || !config.scenario.trim()) {
    throw new Error('Mokapi: parameters.mokapi.scenario is required.');
  }
  if (!Array.isArray(config.routes) || config.routes.length === 0) {
    throw new Error('Mokapi: parameters.mokapi.routes must contain at least one route.');
  }
}

function createForwardingHandler(
  definition: MokapiRouteDefinition,
  scenario: string,
  options: MokapiForwardingOptions,
): HttpHandler {
  const route = validateRoute(definition);
  return new HttpHandler(handlerMethod(route.method), route.path, async ({ request }) => {
    const base = options.browserUrl || options.proxyPath;
    const url = forwardingUrl(request.url, base, options.scenarioParameter, scenario);
    try {
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.delete('content-length');
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
      return await fetch(bypass(url, {
        method: request.method,
        headers,
        body,
        signal: request.signal,
        redirect: 'manual',
      }));
    } catch (error: unknown) {
      if (request.signal.aborted) throw error;
      console.error(`Mokapi request failed (${url}):`, error);
      return HttpResponse.json(
        { message: `Mokapi request failed at ${base}. Check the server and proxy configuration.` },
        { status: 502 },
      );
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function replaceMswHandlers(original: unknown, handlers: HttpHandler[], handlerGroup?: string): unknown {
  const parameters = isRecord(original) ? original : {};
  if (!handlerGroup) return { ...parameters, handlers };

  const groups = parameters.handlers;
  if (!isRecord(groups) || !Object.hasOwn(groups, handlerGroup)) {
    throw new Error(`Mokapi: MSW handler group "${handlerGroup}" is missing.`);
  }
  return { ...parameters, handlers: { ...groups, [handlerGroup]: handlers } };
}

export function createMokapiLoader<Context extends MokapiLoaderContext, Result>(
  loadMsw: LoaderFunction<Context, Result>,
  options?: MokapiForwardingOptions,
): (context: Context) => Promise<Awaited<Result>> {
  if (typeof loadMsw !== 'function') {
    throw new Error('Mokapi: provide your project MSW loader.');
  }
  const resolvedOptions = options ?? settings;
  if (!resolvedOptions) {
    throw new Error('Mokapi: missing addon configuration. Register the Mokapi addon or provide options.');
  }

  return async (context): Promise<Awaited<Result>> => {
    await mockBackendReady;
    const config = context.parameters.mokapi;
    if (!config || context.globals.mockBackend === 'msw') {
      return await loadMsw(context) as Awaited<Result>;
    }

    if (context.globals.mockBackend !== 'mokapi') {
      throw new Error(`Mokapi: unknown backend ${String(context.globals.mockBackend)}`);
    }
    validateMokapiParameters(config);
    const handlers = config.routes.map((route) => createForwardingHandler(route, config.scenario, resolvedOptions));
    const msw = replaceMswHandlers(context.parameters.msw, handlers, config.handlerGroup);

    const parameters = context.parameters;
    context.parameters = { ...parameters, msw };
    try {
      return await loadMsw(context) as Awaited<Result>;
    } finally {
      context.parameters = parameters;
    }
  };
}
