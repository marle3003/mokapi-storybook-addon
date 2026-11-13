/** @jsxRuntime classic */
// The Storybook manager provides `react` but not `react/jsx-runtime`, so this file must not use the automatic runtime.
import React, { useSyncExternalStore, type ReactNode } from 'react';
import { addons, experimental_getStatusStore, types, useGlobals, useStorybookApi, useStorybookState } from 'storybook/manager-api';
import { FORCE_REMOUNT, GLOBALS_UPDATED, SET_GLOBALS, STORY_CHANGED, STORY_RENDER_PHASE_CHANGED } from 'storybook/internal/core-events';
import { Badge, IconButton, Link, ScrollArea, ToggleButton, TooltipNote, WithTooltip } from 'storybook/internal/components';
import { CheckIcon, CircleHollowIcon, StopAltIcon, SyncIcon, VerifiedIcon } from '@storybook/icons';
import { styled, useTheme } from 'storybook/theming';
import { initialRemountState, nextRemount, type RemountEvent } from './remount.js';
import { initialRendering, isRendering, nextRendering, type Rendering, type RenderingEvent } from './rendering.js';
import {
  BODY_LIMIT,
  countLine,
  formatBody,
  formatTime,
  KIND_LABELS,
  methodColor,
  reportBadge,
  reportHeadline,
  sidebarStatus,
  statusColor,
  statusLabel,
  statusText,
  STATUS_TYPE_ID,
  testModeText,
  type BadgeColor,
  type ReportBadge,
} from './report.js';
import {
  PANEL_EVENT,
  initialPanelState,
  invalidCount,
  reducePanel,
  resultsOfStory,
  type Entry,
  type MessageDetails,
  type Notice,
  type PanelAction,
  type PanelState,
} from './results.js';
import { toggleState } from './toggle.js';
import type { ResolvedAddonOptions } from './types.js';

declare global {
  interface Window {
    __MOKAPI_PANEL_OPTIONS__?: Pick<ResolvedAddonOptions, 'dashboardUrl'>;
  }
}

const PANEL_ID = 'mokapi/validation';
const TOGGLE_ID = 'mokapi/validation-toggle';
const TOGGLE_NAME = 'Validate with Mokapi';
const TEST_PROVIDER_ID = 'mokapi/test-provider';

// The panel is only mounted while its tab is open, but the badge must count while it is closed.
// So the results live here and both the tab title and the panel subscribe to them.
let panelState: PanelState = initialPanelState;
// Fed by the render phases, so Rerun is right even when the panel opens while a story renders.
let rendering: Rendering = initialRendering;
const subscribers = new Set<() => void>();

const notifySubscribers = (): void => subscribers.forEach((notify) => notify());

function receive(action: PanelAction): void {
  panelState = reducePanel(panelState, action);
  notifySubscribers();
}

function trackRendering(event: RenderingEvent): void {
  rendering = nextRendering(rendering, event);
  notifySubscribers();
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}

function useResultsOfSelectedStory(): PanelState {
  const state = useSyncExternalStore(subscribe, () => panelState);
  return resultsOfStory(state, useStorybookState().storyId);
}

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
const Hint = styled.p({ margin: 0, padding: 16 });
const Title = styled.span({ display: 'inline-flex', gap: 6, alignItems: 'center' });
const ProviderLabel = styled.div({ padding: '8px 12px' });

// Same look as the status badge of Storybook's Interactions panel, which is not exported.
const StatusBadge = styled.span<{ status: BadgeColor }>(({ theme, status }) => ({
  display: 'inline-block',
  padding: '4px 6px 4px 8px',
  borderRadius: 4,
  backgroundColor: theme.color[status],
  color: 'white',
  textTransform: 'uppercase',
  fontSize: theme.typography.size.s1,
  fontWeight: theme.typography.weight.bold,
  letterSpacing: 3,
  minWidth: 65,
  textAlign: 'center',
}));
// A code or method next to the 12 px row text: same color, radius and weight, but no button look.
// The base font, because the badge sits in the mono font of `EntryUrl`.
const CodeBadge = styled(StatusBadge)(({ theme }) => ({
  textTransform: 'none',
  letterSpacing: 0,
  minWidth: 0,
  padding: '1px 6px',
  fontFamily: theme.typography.fonts.base,
}));
const ToolbarRow = styled.div(({ theme }) => ({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 12,
  padding: '8px 15px',
  borderBottom: `1px solid ${theme.appBorderColor}`,
  background: theme.background.app,
}));
const Headline = styled.span({ fontWeight: 'bold' });
const ToolbarText = styled.span(({ theme }) => ({ color: theme.textMutedColor }));
const ToolbarActions = styled.div({ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto' });
const NoticeRow = styled.div<{ kind: Notice['kind'] }>(({ theme, kind }) => ({
  padding: '8px 15px',
  borderBottom: `1px solid ${theme.appBorderColor}`,
  color: kind === 'worker-missing' ? theme.color.warning : theme.color.negative,
}));
const EmptyText = styled.p({ margin: 0, padding: '8px 15px' });
const EntryList = styled.ul({ margin: 0, padding: 0, listStyle: 'none' });
// The invalid rows get the error background of failed steps in the Interactions panel. Storybook's
// `transparentize` is no manager global, so the dark theme uses its negative color (#FF4400) at 7 % as literal.
const EntryRow = styled.li<{ status: Entry['status'] }>(({ theme, status }) => ({
  borderBottom: `1px solid ${theme.appBorderColor}`,
  padding: '8px 15px',
  overflowWrap: 'anywhere',
  ...(status === 'invalid' && { backgroundColor: theme.base === 'dark' ? 'rgba(255, 68, 0, 0.07)' : theme.background.warning }),
}));
const EntryHeader = styled.div({ display: 'flex', alignItems: 'center', gap: 8 });
const EntryKind = styled.strong<{ status: Entry['status'] }>(({ theme, status }) => ({
  color: status === 'valid' ? theme.color.positive : status === 'invalid' ? theme.color.negative : theme.color.mediumdark,
}));
const EntryUrl = styled.span(({ theme }) => ({ fontFamily: theme.typography.fonts.mono }));
const EntryMeta = styled.span({ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto', whiteSpace: 'nowrap' });
const EntryTime = styled.span(({ theme }) => ({ color: theme.textMutedColor }));
const Errors = styled.ul({ margin: '6px 0 0', paddingLeft: 40 });
const EntryMessage = styled.div({ paddingLeft: 24 });
const Details = styled.details({ marginTop: 6, paddingLeft: 24 });
const Summary = styled.summary({ cursor: 'pointer' });
const Pre = styled.pre(({ theme }) => ({
  margin: '4px 0',
  fontFamily: theme.typography.fonts.mono,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}));

function PanelTitle() {
  const count = invalidCount(useResultsOfSelectedStory());
  return (
    <Title>
      Mokapi
      {count > 0 && <Badge compact status="negative">{count}</Badge>}
    </Title>
  );
}

function EntryIcon({ status }: { status: Entry['status'] }) {
  const { color } = useTheme();
  if (status === 'valid') return <CheckIcon color={color.positive} />;
  if (status === 'invalid') return <StopAltIcon color={color.negative} />;
  return <CircleHollowIcon color={color.mediumdark} />;
}

const headerLines = (headers: Record<string, string>): string =>
  Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n');

function BadgeTooltip({ note, children }: { note: string; children: ReactNode }) {
  return (
    <WithTooltip hasChrome={false} placement="top" trigger="hover" tooltip={<TooltipNote note={note} />}>
      {children}
    </WithTooltip>
  );
}

function HttpStatusBadge({ statusCode }: { statusCode: number }) {
  return (
    <BadgeTooltip note={statusText(statusCode) ?? String(statusCode)}>
      <CodeBadge status={statusColor(statusCode)} aria-label={statusLabel(statusCode)} data-testid="mokapi-status-badge">
        {statusCode}
      </CodeBadge>
    </BadgeTooltip>
  );
}

function MethodBadge({ method }: { method: string }) {
  return <CodeBadge status={methodColor(method)} data-testid="mokapi-method-badge">{method.toUpperCase()}</CodeBadge>;
}

function Message({ title, summary, details }: { title: string; summary: ReactNode; details?: MessageDetails }) {
  if (!details) return null;
  return (
    <div>
      <strong>{title}</strong>
      {' '}
      <EntryUrl>{summary}</EntryUrl>
      {Object.keys(details.headers).length > 0 && <Pre>{headerLines(details.headers)}</Pre>}
      <Pre>{formatBody(details.body)}</Pre>
      {details.truncated && <div>{`(truncated to ${BODY_LIMIT.toLocaleString('en-US')} characters)`}</div>}
    </div>
  );
}

function EntryItem({ entry }: { entry: Entry }) {
  return (
    <EntryRow status={entry.status} data-testid="mokapi-entry" data-status={entry.status}>
      <EntryHeader>
        <EntryIcon status={entry.status} />
        <EntryKind status={entry.status}>{KIND_LABELS[entry.status]}</EntryKind>
        <EntryUrl>
          <MethodBadge method={entry.method} />
          {' '}
          {entry.operation && entry.operationUrl ? (
            <Link
              href={entry.operationUrl}
              target="_blank"
              rel="noreferrer"
              title={`${entry.operation.method} ${entry.operation.path}`}
              data-testid="mokapi-operation"
            >
              {entry.url}
            </Link>
          ) : entry.url}
        </EntryUrl>
        <EntryMeta data-testid="mokapi-entry-meta">
          <HttpStatusBadge statusCode={entry.statusCode} />
          <EntryTime data-testid="mokapi-entry-time">{formatTime(entry.time)}</EntryTime>
        </EntryMeta>
      </EntryHeader>
      {entry.message && <EntryMessage>{entry.message}</EntryMessage>}
      {entry.errors.length > 0 && (
        <Errors>
          {entry.errors.map((error, index) => (
            <li key={index}><code>{error.location}</code>{` ${error.message}`}</li>
          ))}
        </Errors>
      )}
      {(entry.request || entry.response) && (
        <Details data-testid="mokapi-details">
          <Summary>Request / Response</Summary>
          <Message title="Request" summary={<MethodBadge method={entry.method} />} details={entry.request} />
          <Message title="Response" summary={<HttpStatusBadge statusCode={entry.statusCode} />} details={entry.response} />
        </Details>
      )}
    </EntryRow>
  );
}

function ReportStatusBadge({ badge, testMode }: { badge: ReportBadge; testMode: NonNullable<PanelState['testMode']> }) {
  return (
    <BadgeTooltip note={testModeText(testMode)}>
      <StatusBadge status={badge.status} data-testid="mokapi-report-badge">{badge.label}</StatusBadge>
    </BadgeTooltip>
  );
}

// Remounts the story like the switch of the validation does, so story, validation and report start again.
// While the story renders this would make Storybook reload the preview.
function RerunButton() {
  const api = useStorybookApi();
  const { storyId } = useStorybookState();
  const renderingStories = useSyncExternalStore(subscribe, () => rendering);
  return (
    <IconButton
      padding="small"
      variant="ghost"
      ariaLabel="Rerun"
      data-testid="mokapi-rerun"
      disabled={storyId === undefined || isRendering(renderingStories, storyId)}
      onClick={() => api.emit(FORCE_REMOUNT, { storyId })}
    >
      <SyncIcon />
    </IconButton>
  );
}

function Toolbar({ state, dashboardUrl }: { state: PanelState; dashboardUrl?: string }) {
  const { entries, testMode, report } = state;
  const badge = reportBadge(testMode, report);
  const headline = reportHeadline(report);
  const counts = countLine(entries);
  return (
    <ToolbarRow>
      {badge && testMode && <ReportStatusBadge badge={badge} testMode={testMode} />}
      {headline && <Headline data-testid="mokapi-report-headline">{headline}</Headline>}
      {counts && <ToolbarText data-testid="mokapi-report-counts">{counts}</ToolbarText>}
      {testMode === 'off' && <ToolbarText data-testid="mokapi-test-mode">{testModeText(testMode)}</ToolbarText>}
      <ToolbarActions>
        <RerunButton />
        {dashboardUrl && <Link href={dashboardUrl} target="_blank" rel="noreferrer">Open Mokapi dashboard</Link>}
      </ToolbarActions>
    </ToolbarRow>
  );
}

function ValidationToggle() {
  const [globals, updateGlobals] = useGlobals();
  const { pressed, next, tooltip } = toggleState(globals.mokapiValidation);
  return (
    <ToggleButton
      padding="small"
      variant="ghost"
      ariaLabel={TOGGLE_NAME}
      tooltip={tooltip}
      pressed={pressed}
      onClick={() => updateGlobals({ mokapiValidation: next })}
    >
      <VerifiedIcon />
    </ToggleButton>
  );
}

function PanelFrame({ children }: { children: ReactNode }) {
  return <PanelRoot><PanelScroll vertical>{children}</PanelScroll></PanelRoot>;
}

function Panel() {
  const [globals] = useGlobals();
  const { selectedPanel, layout } = useStorybookState();
  const state = useResultsOfSelectedStory();
  const dashboardUrl = window.__MOKAPI_PANEL_OPTIONS__?.dashboardUrl;
  if (selectedPanel !== PANEL_ID || !layout.showPanel) return null;
  if (globals.mokapiValidation !== 'on') {
    return <PanelFrame><Hint>{`Turn on validation with the "${TOGGLE_NAME}" toggle in the toolbar.`}</Hint></PanelFrame>;
  }
  return (
    <PanelFrame>
      <Toolbar state={state} dashboardUrl={dashboardUrl} />
      {state.notices.map((notice) => (
        <NoticeRow key={`${notice.kind}-${notice.message}`} kind={notice.kind} role="alert">{notice.message}</NoticeRow>
      ))}
      {!state.entries.length && <EmptyText>No responses validated since this story was mounted.</EmptyText>}
      <EntryList role="list">
        {state.entries.map((entry) => <EntryItem key={entry.sequence} entry={entry} />)}
      </EntryList>
    </PanelFrame>
  );
}

addons.register('mokapi', (api) => {
  const statusStore = experimental_getStatusStore(STATUS_TYPE_ID);
  api.on(PANEL_EVENT, (action: PanelAction) => {
    receive(action);
    if (action.type !== 'report') return;
    const status = sidebarStatus(action.storyId, action);
    if (status) statusStore.set([status]);
    else statusStore.unset([action.storyId]);
  });
  // Selecting the status in the sidebar shows the details.
  statusStore.onSelect(() => {
    api.setSelectedPanel(PANEL_ID);
    api.togglePanel(true);
  });
  let remount = nextRemount(initialRemountState, { type: 'initial', validation: api.getGlobals().mokapiValidation }).state;
  const handle = (event: RemountEvent): void => {
    const next = nextRemount(remount, event);
    remount = next.state;
    if (next.remount) api.emit(FORCE_REMOUNT, { storyId: next.remount });
  };
  // The preview announces the initial globals with SET_GLOBALS, later changes with GLOBALS_UPDATED.
  api.on(SET_GLOBALS, ({ globals }: { globals: Record<string, unknown> }) => handle({ type: 'initial', validation: globals.mokapiValidation }));
  api.on(GLOBALS_UPDATED, ({ globals }: { globals: Record<string, unknown> }) => {
    const inStoryView = api.getUrlState().viewMode === 'story';
    handle({ type: 'switched', validation: globals.mokapiValidation, storyId: inStoryView ? api.getCurrentStoryData()?.id : undefined });
  });
  api.on(STORY_CHANGED, () => handle({ type: 'story-changed' }));
  // `loading` is the first phase of every render, `finished` the last one.
  api.on(STORY_RENDER_PHASE_CHANGED, ({ newPhase, storyId }: { newPhase: string; storyId: string }) => {
    const type = newPhase === 'loading' ? 'started' : newPhase === 'finished' ? 'finished' : undefined;
    if (!type) return;
    handle({ type, storyId });
    trackRendering({ type, storyId });
  });
  addons.add(TOGGLE_ID, {
    type: types.TOOL,
    title: TOGGLE_NAME,
    match: ({ viewMode, tabId }) => viewMode === 'story' && !tabId,
    render: () => <ValidationToggle />,
  });
  // Storybook's "Clear all statuses" calls `clear` of every test provider. The provider has no run of its own.
  addons.add(TEST_PROVIDER_ID, {
    type: types.experimental_TEST_PROVIDER,
    clear: () => statusStore.unset(),
    render: () => <ProviderLabel>Mokapi contract validation</ProviderLabel>,
  });
  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: () => <PanelTitle />,
    match: ({ viewMode }) => viewMode === 'story',
    render: ({ active }) => active ? <Panel /> : null,
  });
});
