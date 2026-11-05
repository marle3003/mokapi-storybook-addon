import { validateRoute } from './forwarding.js';
import type { MokapiEvent, MokapiEventPage, MokapiRouteDefinition } from './types.js';

const EVENTS_PAGE_SIZE = 25;

export function eventsUrl(
  base: string,
  api: string,
  definition: MokapiRouteDefinition,
  page: number,
): string {
  const route = validateRoute(definition);
  const query = new URLSearchParams({
    'traits[namespace]': 'http',
    'traits[name]': api,
    'traits[path]': route.path,
    page: String(page),
    size: String(EVENTS_PAGE_SIZE),
  });
  if (typeof route.method === 'string') query.set('traits[method]', route.method);
  return `${base.replace(/\/$/, '')}/api/events?${query}`;
}

function eventScenario(event: MokapiEvent, scenarioParameter: string): string | null {
  if (typeof event.id !== 'string' || typeof event.data?.request?.url !== 'string') {
    throw new Error('Mokapi dashboard API returned an invalid HTTP event.');
  }
  const requestUrl = new URL(event.data.request.url);
  return requestUrl.searchParams.get(scenarioParameter);
}

export async function fetchEvents(
  url: string,
  scenario: string,
  scenarioParameter: string,
  signal?: AbortSignal,
): Promise<MokapiEventPage> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Mokapi dashboard API returned HTTP ${response.status}.`);
  }

  const result = await response.json() as MokapiEventPage;
  const items = result.items.filter((event) => eventScenario(event, scenarioParameter) === scenario);
  return { ...result, items };
}
