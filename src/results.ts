import type { TestMode } from './types.js';
import type { Operation, ValidationError } from './validation.js';

// The preview sends the story's validation results to the manager panel on this channel event.
export const PANEL_EVENT = 'mokapi/validation';

/** What the panel shows of a request or response; `body` is cut to `BODY_LIMIT` characters and `truncated` says so. */
export interface MessageDetails {
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export interface Entry {
  /** Order in which the request was captured, because results arrive in the order Mokapi answers. */
  sequence: number;
  time: number;
  method: string;
  url: string;
  statusCode: number;
  status: 'valid' | 'invalid' | 'not-in-contract' | 'unreachable';
  errors: ValidationError[];
  /** The contract operation Mokapi matched (valid and invalid entries) and its page in the dashboard. */
  operation?: Operation;
  operationUrl?: string;
  request?: MessageDetails;
  response?: MessageDetails;
  /** Set when Mokapi could not be reached: the URL and a hint to the dashboardUrl option. */
  message?: string;
}

export interface Notice {
  kind: 'unreachable' | 'endpoint-missing' | 'config-error' | 'timeout' | 'worker-missing' | 'partial-unsupported';
  message: string;
}

export type ReportStatus = 'passed' | 'warning' | 'failed';

/**
 * The verdict of the story's afterEach: the status, the headline of the result (empty when passed) and the number of
 * invalid and valid responses behind it. The sidebar status carries `invalid` and tells a passed story (`valid > 0`)
 * from a skipped one, for stories the manager holds no entries of.
 */
export interface Report {
  status: ReportStatus;
  headline: string;
  invalid: number;
  valid: number;
}

// renderId is unique per mount of a story (a re-render keeps it), so late answers of an earlier mount can be recognized.
// The report names its story, because the sidebar status is set for it and stories on a Docs page count their renderIds each.
// testMode is set while the render is validated, partial when it validates with partial responses.
export type PanelAction =
  | { type: 'render-started'; storyId: string; renderId: number; testMode?: TestMode; partial?: true }
  | { type: 'result'; renderId: number; entry: Entry }
  | { type: 'notice'; renderId: number; notice: Notice }
  | ({ type: 'report'; renderId: number; storyId: string } & Report);

export interface PanelState {
  storyId?: string;
  renderId: number;
  testMode?: TestMode;
  /** Set while the story validates with partial responses. */
  partial?: true;
  entries: Entry[];
  notices: Notice[];
  /** Set once the story's afterEach has judged the render. */
  report?: Report;
}

export const initialPanelState: PanelState = { renderId: 0, entries: [], notices: [] };

export function reducePanel(state: PanelState, action: PanelAction): PanelState {
  if (action.type === 'render-started') {
    return { ...initialPanelState, storyId: action.storyId, renderId: action.renderId, ...(action.testMode && { testMode: action.testMode }), ...(action.partial && { partial: action.partial }) };
  }
  if (action.renderId !== state.renderId) return state;
  if (action.type === 'report') return { ...state, report: { status: action.status, headline: action.headline, invalid: action.invalid, valid: action.valid } };
  if (action.type === 'result') {
    return { ...state, entries: [...state.entries, action.entry].sort((a, b) => a.sequence - b.sequence) };
  }
  const known = state.notices.some(({ kind, message }) => kind === action.notice.kind && message === action.notice.message);
  return known ? state : { ...state, notices: [...state.notices, action.notice] };
}

export const resultsOfStory = (state: PanelState, storyId: string): PanelState =>
  state.storyId === storyId ? state : initialPanelState;

export const invalidCount = (state: Pick<PanelState, 'entries'>): number =>
  state.entries.filter(({ status }) => status === 'invalid').length;

export const validCount = (state: Pick<PanelState, 'entries'>): number =>
  state.entries.filter(({ status }) => status === 'valid').length;
