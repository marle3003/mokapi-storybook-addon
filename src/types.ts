export type MockBackend = 'msw' | 'mokapi';

export interface MokapiAddonOptions {
  target: string;
  dashboardUrl?: string;
  proxyPath?: string;
  defaultBackend?: MockBackend;
  scenarioParameter?: string;
  browserUrl?: string;
}

export type SerializedMethod = string | { source: string; flags: string };

export interface MokapiRoute {
  method?: SerializedMethod;
  path: string;
}

export type MokapiRouteDefinition = string | MokapiRoute;

export interface MokapiStoryParameters {
  handlerGroup?: string;
  /**
   * `info.title` of the OpenAPI contract the routes belong to. Without it, the
   * routes apply to every API that Mokapi mocks, which matters when several
   * APIs share a path.
   */
  api?: string;
  scenario: string;
  routes: MokapiRouteDefinition[];
}

export type ResolvedAddonOptions =
  Required<Omit<MokapiAddonOptions, 'browserUrl'>> & Pick<MokapiAddonOptions, 'browserUrl'>;

export interface RuntimeOptions {
  proxyPath: string;
  defaultBackend: MockBackend;
  scenarioParameter: string;
  browserUrl?: string;
}

export interface ManagerPanelOptions {
  dashboardUrl: string;
  eventsUrl: string;
  scenarioParameter: string;
  defaultBackend: MockBackend;
}

export interface MokapiEventAction {
  tags?: { file?: string; name?: string };
  duration?: number;
  error?: unknown;
  logs?: unknown;
  parameters?: unknown;
}

export interface MokapiEventRequest {
  method: string;
  url: string;
  [key: string]: unknown;
}

export interface MokapiEventResponse {
  statusCode?: number;
  body?: unknown;
  [key: string]: unknown;
}

export interface MokapiEvent {
  id: string;
  time: string;
  traits: { name: string; path: string };
  duration: number;
  data: {
    request: MokapiEventRequest;
    response?: MokapiEventResponse;
    actions?: MokapiEventAction[];
    duration: number;
  };
}

export interface MokapiEventPage {
  items: MokapiEvent[];
  total: number;
  page: number;
  size: number;
}
