/** @jsxRuntime classic */
// The Storybook manager provides `react` but not `react/jsx-runtime`, so this file must not use the automatic runtime.
import React, { useEffect, useState, type ChangeEvent, type ReactNode } from 'react';
import { addons, types, useGlobals, useParameter, useStorybookState } from 'storybook/manager-api';
import { UPDATE_GLOBALS } from 'storybook/internal/core-events';
import { Button, Form, Link, ScrollArea } from 'storybook/internal/components';
import { styled } from 'storybook/theming';
import { eventApis, eventsUrl, fetchEvents, panelSummary } from './mokapi-events.js';
import { handlerMethod, methodLabel } from './forwarding.js';
import {
  initialMockBackend,
  installManagerMockBackendSync,
  isMockBackend,
} from './mock-backend-sync.js';
import type {
  ManagerPanelOptions,
  MokapiEvent,
  MokapiEventPage,
  MokapiRouteDefinition,
  MokapiStoryParameters,
  MockBackend,
} from './types.js';

declare global {
  interface Window {
    __MOKAPI_PANEL_OPTIONS__?: ManagerPanelOptions;
  }
}

const REQUEST_PANEL_ID = 'mokapi/requests';
const REFRESH_INTERVAL_MS = 2000;

const PanelRoot = styled.div(({ theme }) => ({
  height: '100%',
  minHeight: 0,
  overflow: 'hidden',
  color: theme.color.defaultText,
  background: theme.background.content,
  fontFamily: theme.typography.fonts.base,
  fontSize: theme.typography.size.s1,
}));
const PanelScroll = styled(ScrollArea)({ height: '100%' });
const Content = styled.section({ padding: 16, minWidth: 0 });
const Toolbar = styled.div({
  display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
});
const OperationLabel = styled.label({
  display: 'flex', gap: 8, alignItems: 'center',
});
const Disclosure = styled.details(({ theme }) => ({
  padding: '6px 0',
  '& > summary': {
    cursor: 'pointer',
    padding: '6px 0',
    overflowWrap: 'anywhere',
    '&:focus-visible': { outline: `2px solid ${theme.color.secondary}`, outlineOffset: 2 },
  },
}));
const RequestDisclosure = styled(Disclosure)(({ theme }) => ({
  borderBottom: `1px solid ${theme.appBorderColor}`,
  padding: '8px 0',
}));
const DataBlock = styled.pre(({ theme }) => ({
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  fontFamily: theme.typography.fonts.mono,
  fontSize: theme.typography.size.s1,
  background: theme.background.app,
  border: `1px solid ${theme.appBorderColor}`,
  borderRadius: theme.appBorderRadius,
  padding: 12,
  margin: '8px 0',
}));
const RequestUrl = styled.p(({ theme }) => ({
  overflowWrap: 'anywhere', fontFamily: theme.typography.fonts.mono,
}));
const ErrorMessage = styled.p(({ theme }) => ({ color: theme.color.negative }));
const WarningMessage = styled.p(({ theme }) => ({ color: theme.color.warning }));

interface DetailsProps {
  title: string;
  value: unknown;
}

function Details({ title, value }: DetailsProps) {
  return (
    <Disclosure>
      <summary>{title}</summary>
      <DataBlock>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</DataBlock>
    </Disclosure>
  );
}

interface ScriptExecutionProps {
  action: NonNullable<MokapiEvent['data']['actions']>[number];
}

function ScriptExecution({ action }: ScriptExecutionProps) {
  const name = action.tags?.file ?? action.tags?.name ?? 'Script';
  return (
    <section>
      <RequestUrl>{`${name} (${action.duration} ms)`}</RequestUrl>
      {action.error !== undefined && <Details title="Script error" value={action.error} />}
      <Details title="Console logs" value={action.logs ?? []} />
      <Details title="Script parameters" value={action.parameters ?? []} />
    </section>
  );
}

interface RequestEventProps {
  event: MokapiEvent;
}

function RequestEvent({ event }: RequestEventProps) {
  const { request, response, actions, duration } = event.data;
  return (
    <RequestDisclosure>
      <summary>
        {`${response?.statusCode ?? 'No response'} | ${request.method} ${event.traits.path} | ${duration} ms | ${event.time}`}
      </summary>
      <RequestUrl>{request.url}</RequestUrl>
      {response?.statusCode !== undefined && response.statusCode >= 400 && (
        <p role="note">
          HTTP error response. Inspect the response and scripts below; a mocked error status is not necessarily a contract violation.
        </p>
      )}
      {response?.body !== undefined && <Details title="Response body / validation errors" value={response.body} />}
      <Details title="Request" value={request} />
      <Details title="Response" value={response} />
      <h4>Executed scripts</h4>
      {(actions ?? []).map((action, index) => <ScriptExecution key={index} action={action} />)}
      {!actions?.length && <p>No script executions recorded.</p>}
    </RequestDisclosure>
  );
}

function filterRequestMethods(result: MokapiEventPage, route: MokapiRouteDefinition): MokapiEventPage {
  const method = handlerMethod(typeof route === 'string' ? 'GET' : route.method ?? 'GET');
  if (!(method instanceof RegExp)) return result;

  const items = result.items.filter((event) => {
    method.lastIndex = 0;
    return method.test(event.data.request.method);
  });
  return { ...result, items };
}

interface HistoryState {
  loading: boolean;
  error?: string;
  result?: MokapiEventPage;
}

function useRequestHistory(
  config: MokapiStoryParameters,
  settings: ManagerPanelOptions,
  route: MokapiRouteDefinition,
  page: number,
): { historyState: HistoryState; refresh: () => void } {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [historyState, setHistoryState] = useState<HistoryState>({ loading: true });
  const url = eventsUrl(settings.eventsUrl, config.api, route, page);
  // Storybook hands out a new but equal config object on every STORY_PREPARED; depend on the route's content so the list is not reloaded (and expanded entries collapsed).
  const routeKey = JSON.stringify(route);

  useEffect(() => {
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout>;
    setHistoryState({ loading: true });

    const loadRequests = async (): Promise<void> => {
      try {
        const result = await fetchEvents(url, config.scenario, settings.scenarioParameter, controller.signal);
        const filteredResult = filterRequestMethods(result, route);
        if (!controller.signal.aborted) {
          setHistoryState({ loading: false, result: filteredResult });
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          setHistoryState({ loading: false, error: `Cannot load Mokapi requests: ${message}` });
        }
      } finally {
        if (!controller.signal.aborted) {
          refreshTimer = setTimeout(() => { void loadRequests(); }, REFRESH_INTERVAL_MS);
        }
      }
    };
    void loadRequests();
    return () => {
      controller.abort();
      clearTimeout(refreshTimer);
    };
  }, [url, config.scenario, refreshVersion, routeKey, settings.scenarioParameter]);

  const refresh = (): void => setRefreshVersion((version) => version + 1);
  return { historyState, refresh };
}

interface PaginationProps {
  page: number;
  result: MokapiEventPage;
  onPageChange: (page: number) => void;
}

function Pagination({ page, result, onPageChange }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(result.total / result.size));
  return (
    <Toolbar>
      <Button
        variant="outline"
        size="small"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        Previous
      </Button>
      <span>{`Operation page ${page} of ${totalPages}`}</span>
      <Button
        variant="outline"
        size="small"
        disabled={page * result.size >= result.total}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </Button>
    </Toolbar>
  );
}

interface RequestHistoryProps {
  config: MokapiStoryParameters;
  settings: ManagerPanelOptions;
}

function RequestHistory({ config, settings }: RequestHistoryProps) {
  const [routeIndex, setRouteIndex] = useState(0);
  const [page, setPage] = useState(1);
  const route = config.routes[routeIndex];
  const { historyState, refresh } = useRequestHistory(config, settings, route, page);
  const { loading, error, result } = historyState;
  const apis = result ? eventApis(result.items) : [];

  const selectRoute = (event: ChangeEvent<HTMLSelectElement>): void => {
    setRouteIndex(Number(event.target.value));
    setPage(1);
  };

  return (
    <Content>
      <Toolbar>
        <OperationLabel>
          Operation
          <Form.Select value={routeIndex} onChange={selectRoute}>
            {config.routes.map((route, index) => (
              <option key={index} value={index}>
                {typeof route === 'string'
                  ? `GET ${route}`
                  : `${methodLabel(route.method ?? 'GET')} ${route.path}`}
              </option>
            ))}
          </Form.Select>
        </OperationLabel>
        <Button variant="outline" size="small" onClick={refresh}>Refresh</Button>
        <Link href={settings.dashboardUrl} target="_blank" rel="noreferrer">Open Mokapi dashboard</Link>
      </Toolbar>
      <p>{panelSummary(config.api, config.scenario)}</p>
      <p>Operation history filtered by scenario, not by an individual story execution. Auto-refresh every 2 seconds.</p>
      {loading && <p role="status">Loading Mokapi requests...</p>}
      {error && <ErrorMessage role="alert">{error}</ErrorMessage>}
      {result && (
        <div>
          <Pagination page={page} result={result} onPageChange={setPage} />
          {apis.length > 1 && (
            <WarningMessage role="note">
              {`Requests from several APIs match this operation: ${apis.join(', ')}. Set \`api\` in createStoryScenarios(mocks, { api }) to show only one API.`}
            </WarningMessage>
          )}
          {!result.items.length && (
            <p>No requests for this scenario on this operation page. Run the story or check another page.</p>
          )}
          {result.items.map((event) => <RequestEvent key={event.id} event={event} />)}
        </div>
      )}
    </Content>
  );
}

interface PanelFrameProps {
  children?: ReactNode;
}

function PanelFrame({ children }: PanelFrameProps) {
  return <PanelRoot><PanelScroll vertical>{children}</PanelScroll></PanelRoot>;
}

interface PanelMessageProps {
  children: ReactNode;
  error?: boolean;
}

function PanelMessage({ children, error = false }: PanelMessageProps) {
  return (
    <PanelFrame>
      <Content>{error ? <ErrorMessage role="alert">{children}</ErrorMessage> : children}</Content>
    </PanelFrame>
  );
}

function hasConfiguredRoutes(config: MokapiStoryParameters | undefined): config is MokapiStoryParameters {
  return !!config?.routes?.length;
}

function Panel() {
  const config = useParameter<MokapiStoryParameters | undefined>('mokapi');
  const [globals] = useGlobals();
  const { storyId, selectedPanel, layout } = useStorybookState();
  const settings = window.__MOKAPI_PANEL_OPTIONS__;
  if (selectedPanel !== REQUEST_PANEL_ID || !layout.showPanel) return null;
  if (!settings) {
    return <PanelMessage error>Mokapi panel configuration is missing. Restart Storybook.</PanelMessage>;
  }
  if (globals.mockBackend !== 'mokapi') {
    return <PanelMessage>Select Mokapi in the toolbar to inspect request logs.</PanelMessage>;
  }
  if (!hasConfiguredRoutes(config)) {
    return (
      <PanelMessage>
        No routes configured for this story. Use createStoryScenarios(mocks) or set parameters.mokapi.routes to inspect requests.
      </PanelMessage>
    );
  }
  return (
    <PanelFrame>
      <RequestHistory key={`${storyId}-${JSON.stringify(config)}`} config={config} settings={settings} />
    </PanelFrame>
  );
}

addons.register('mokapi', (api) => {
  const configuredBackend = api.getGlobals().mockBackend;
  const fallback: MockBackend = isMockBackend(configuredBackend) ? configuredBackend : 'msw';
  let mockBackend = initialMockBackend(window.location.href, fallback);
  const synchronization = installManagerMockBackendSync(window, () => mockBackend);
  api.on(UPDATE_GLOBALS, ({ globals }) => {
    if (!isMockBackend(globals.mockBackend)) return;
    mockBackend = globals.mockBackend;
    synchronization.update(mockBackend);
  });
  addons.add(REQUEST_PANEL_ID, {
    type: types.PANEL,
    title: 'Mokapi',
    match: ({ viewMode }) => viewMode === 'story',
    render: ({ active }) => active ? <Panel /> : null,
  });
});
