import type { TestMode } from './types.js';
import type { Operation, ValidationError } from './validation.js';

// The preview sends the story's validation results to the manager panel on this channel event.
export const PANEL_EVENT = 'mokapi/validation';

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
  /** Set when Mokapi could not be reached: the URL and a hint to the dashboardUrl option. */
  message?: string;
}

export interface Notice {
  kind: 'unreachable' | 'endpoint-missing' | 'config-error' | 'timeout' | 'worker-missing';
  message: string;
}

// renderId is unique per mount of a story (a re-render keeps it), so late answers of an earlier mount can be recognized.
// testMode is set while the render is validated.
export type PanelAction =
  | { type: 'render-started'; storyId: string; renderId: number; testMode?: TestMode }
  | { type: 'result'; renderId: number; entry: Entry }
  | { type: 'notice'; renderId: number; notice: Notice };

export interface PanelState {
  storyId?: string;
  renderId: number;
  testMode?: TestMode;
  entries: Entry[];
  notices: Notice[];
}

export const initialPanelState: PanelState = { renderId: 0, entries: [], notices: [] };

export function reducePanel(state: PanelState, action: PanelAction): PanelState {
  if (action.type === 'render-started') {
    return { ...initialPanelState, storyId: action.storyId, renderId: action.renderId, ...(action.testMode && { testMode: action.testMode }) };
  }
  if (action.renderId !== state.renderId) return state;
  if (action.type === 'result') {
    return { ...state, entries: [...state.entries, action.entry].sort((a, b) => a.sequence - b.sequence) };
  }
  const known = state.notices.some(({ kind, message }) => kind === action.notice.kind && message === action.notice.message);
  return known ? state : { ...state, notices: [...state.notices, action.notice] };
}

export const resultsOfStory = (state: PanelState, storyId: string): PanelState =>
  state.storyId === storyId ? state : initialPanelState;

export const invalidCount = (state: PanelState): number =>
  state.entries.filter(({ status }) => status === 'invalid').length;
