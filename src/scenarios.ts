import { HttpHandler } from 'msw';
import { validateRoute } from './forwarding.js';
import type { MokapiRoute, MokapiStoryParameters } from './types.js';

export interface ScenarioOptions {
  api?: string;
  handlerGroup?: string;
}

export interface ScenarioParameters<Scenario extends string> {
  msw: { handlers: HttpHandler[] | Record<string, HttpHandler[]> };
  mokapi: MokapiStoryParameters & { scenario: Scenario };
}

function scenarioRoutes(scenario: string, handlers: readonly HttpHandler[]): MokapiRoute[] {
  const routes = new Map<string, MokapiRoute>();
  for (const handler of handlers) {
    if (!(handler instanceof HttpHandler)) {
      throw new Error(`Mokapi: scenario "${scenario}" requires MSW HTTP handlers.`);
    }
    const { method, path } = handler.info;
    if (typeof path !== 'string') {
      throw new Error('Mokapi: routes must use exact relative paths, without query or path patterns.');
    }
    const route = validateRoute({
      method: method instanceof RegExp ? { source: method.source, flags: method.flags } : method,
      path,
    });
    routes.set(JSON.stringify(route), route);
  }
  return [...routes.values()];
}

export function createStoryScenarios<const Scenarios extends Record<string, readonly HttpHandler[]>>(
  scenarios: Scenarios,
  options: ScenarioOptions = {},
): { [Scenario in keyof Scenarios]: ScenarioParameters<Scenario & string> } {
  const { api, handlerGroup } = options;
  if (api !== undefined && (typeof api !== 'string' || !api.trim())) {
    throw new Error('Mokapi: api must be a non-empty OpenAPI title.');
  }
  if (handlerGroup !== undefined && (typeof handlerGroup !== 'string' || !handlerGroup.trim())) {
    throw new Error('Mokapi: handlerGroup must be a non-empty name.');
  }
  const result = {} as { [Scenario in keyof Scenarios]: ScenarioParameters<Scenario & string> };

  for (const scenario of Object.keys(scenarios) as Array<keyof Scenarios & string>) {
    const handlers = scenarios[scenario];
    if (!scenario.trim() || !Array.isArray(handlers) || handlers.length === 0) {
      throw new Error('Mokapi: each scenario needs a non-empty name and at least one HTTP handler.');
    }
    const mswHandlers = handlerGroup ? { [handlerGroup]: [...handlers] } : [...handlers];
    const mokapi: MokapiStoryParameters & { scenario: typeof scenario } = {
      scenario,
      routes: scenarioRoutes(scenario, handlers),
    };
    if (api !== undefined) mokapi.api = api;
    if (handlerGroup !== undefined) mokapi.handlerGroup = handlerGroup;

    result[scenario] = { msw: { handlers: mswHandlers }, mokapi };
  }

  return result;
}
