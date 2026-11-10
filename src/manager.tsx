/** @jsxRuntime classic */
// The Storybook manager provides `react` but not `react/jsx-runtime`, so this file must not use the automatic runtime.
import React, { useSyncExternalStore, type ReactNode } from 'react';
import { addons, types, useGlobals, useStorybookState } from 'storybook/manager-api';
import { FORCE_REMOUNT, GLOBALS_UPDATED, SET_GLOBALS, STORY_CHANGED, STORY_FINISHED } from 'storybook/internal/core-events';
import { Badge, Link, ScrollArea, ToggleButton } from 'storybook/internal/components';
import { VerifiedIcon } from '@storybook/icons';
import { styled } from 'storybook/theming';
import { initialRemountState, nextRemount, type RemountEvent } from './remount.js';
import {
  PANEL_EVENT,
  initialPanelState,
  invalidCount,
  reducePanel,
  resultsOfStory,
  type Entry,
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
const STATUS_LABELS: Record<Entry['status'], string> = {
  valid: 'valid',
  invalid: 'invalid',
  'not-in-contract': 'not in contract',
  unreachable: 'Mokapi not reachable',
};

// The panel is only mounted while its tab is open, but the badge must count while it is closed.
// So the results live here and both the tab title and the panel subscribe to them.
let panelState: PanelState = initialPanelState;
const subscribers = new Set<() => void>();

function receive(action: PanelAction): void {
  panelState = reducePanel(panelState, action);
  subscribers.forEach((notify) => notify());
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
const Content = styled.section({ padding: 16, minWidth: 0 });
const Title = styled.span({ display: 'inline-flex', gap: 6, alignItems: 'center' });
const EntryRow = styled.li(({ theme }) => ({
  borderBottom: `1px solid ${theme.appBorderColor}`,
  padding: '8px 0',
  overflowWrap: 'anywhere',
}));
const EntryStatus = styled.strong<{ status: Entry['status'] }>(({ theme, status }) => ({
  color: status === 'valid' ? theme.color.positive : status === 'invalid' ? theme.color.negative : theme.color.mediumdark,
}));
const EntryUrl = styled.span(({ theme }) => ({ fontFamily: theme.typography.fonts.mono }));
const Errors = styled.ul({ margin: '6px 0 0', paddingLeft: 20 });
const NoticeMessage = styled.p<{ kind: Notice['kind'] }>(({ theme, kind }) => ({
  color: kind === 'worker-missing' ? theme.color.warning : theme.color.negative,
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

function EntryItem({ entry }: { entry: Entry }) {
  return (
    <EntryRow data-testid="mokapi-entry" data-status={entry.status}>
      <EntryStatus status={entry.status}>{STATUS_LABELS[entry.status]}</EntryStatus>
      {' '}
      <EntryUrl>{`${entry.method} ${entry.url}`}</EntryUrl>
      {` | ${entry.statusCode} | ${new Date(entry.time).toLocaleTimeString()}`}
      {entry.message && <div>{entry.message}</div>}
      {entry.errors.length > 0 && (
        <Errors>
          {entry.errors.map((error, index) => (
            <li key={index}><code>{error.location}</code>{` ${error.message}`}</li>
          ))}
        </Errors>
      )}
    </EntryRow>
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
  return <PanelRoot><PanelScroll vertical><Content>{children}</Content></PanelScroll></PanelRoot>;
}

function Panel() {
  const [globals] = useGlobals();
  const { selectedPanel, layout } = useStorybookState();
  const { entries, notices } = useResultsOfSelectedStory();
  const dashboardUrl = window.__MOKAPI_PANEL_OPTIONS__?.dashboardUrl;
  if (selectedPanel !== PANEL_ID || !layout.showPanel) return null;
  if (globals.mokapiValidation !== 'on') {
    return <PanelFrame><p>{`Turn on validation with the "${TOGGLE_NAME}" toggle in the toolbar.`}</p></PanelFrame>;
  }
  return (
    <PanelFrame>
      {notices.map((notice) => (
        <NoticeMessage key={`${notice.kind}-${notice.message}`} kind={notice.kind} role="alert">{notice.message}</NoticeMessage>
      ))}
      {dashboardUrl && <Link href={dashboardUrl} target="_blank" rel="noreferrer">Open Mokapi dashboard</Link>}
      {!entries.length && <p>No responses validated since this story was rendered.</p>}
      <ul role="list" style={{ listStyle: 'none', padding: 0 }}>
        {entries.map((entry) => <EntryItem key={entry.sequence} entry={entry} />)}
      </ul>
    </PanelFrame>
  );
}

addons.register('mokapi', (api) => {
  api.on(PANEL_EVENT, receive);
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
  api.on(STORY_FINISHED, ({ storyId }: { storyId: string }) => handle({ type: 'finished', storyId }));
  addons.add(TOGGLE_ID, {
    type: types.TOOL,
    title: TOGGLE_NAME,
    match: ({ viewMode, tabId }) => viewMode === 'story' && !tabId,
    render: () => <ValidationToggle />,
  });
  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: () => <PanelTitle />,
    match: ({ viewMode }) => viewMode === 'story',
    render: ({ active }) => active ? <Panel /> : null,
  });
});
