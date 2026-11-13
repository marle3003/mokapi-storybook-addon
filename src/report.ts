import { isTestMode } from './options.js';
import type { Status } from 'storybook/internal/types';
import type { Entry, Notice, PanelState, Report, ReportStatus } from './results.js';
import type { TestMode } from './types.js';
import type { Operation } from './validation.js';

export const VALIDATION_TIMEOUT_MS = 4000;
// A request is started by the component after the story rendered and reaches `request:start` only after
// MSW's service worker answered, so afterEach waits until no request has started for a moment.
export const QUIET_WINDOW_MS = 100;
export const QUIET_WINDOW_MAX_MS = 1000;

const enc = encodeURIComponent;

// The page of the operation in Mokapi's dashboard, as its HTTP service view builds it: every path
// segment on its own, the method in lower case.
export function operationUrl(dashboardUrl: string, { api, method, path }: Operation): string {
  const segments = path.substring(1).split('/').map(enc).join('/');
  return `${dashboardUrl}/dashboard/http/services/${enc(api)}/${segments}/${method.toLowerCase()}`;
}

export const INVALID_TEST_PARAMETER_MESSAGE = "Mokapi: parameters.mokapi.test must be 'error', 'todo' or 'off'.";

// `request` is the method and path with query, e.g. `GET /api/profile/1`.
export const timeoutMessage = (request: string): string =>
  `Mokapi validation did not finish within ${VALIDATION_TIMEOUT_MS / 1000} s (${request}).`;

// An invalid value falls back to the project default; the caller reports it as configuration error.
export function resolveTestMode(parameter: unknown, defaultTest: TestMode): { mode: TestMode; invalid: boolean } {
  if (parameter === undefined) return { mode: defaultTest, invalid: false };
  return isTestMode(parameter) ? { mode: parameter, invalid: false } : { mode: defaultTest, invalid: true };
}

const TEST_MODE_TEXTS: Record<TestMode, string> = {
  error: 'Test mode: error. Contract errors make this story fail.',
  todo: 'Test mode: todo. Contract errors are reported as warnings, the story stays green.',
  off: 'Test mode: off. Contract errors are shown here only.',
};

export const testModeText = (mode: TestMode): string => TEST_MODE_TEXTS[mode];

// Not in contract and a missing worker are shown in the panel only: a project with partial contracts
// would get a warning on every story otherwise.
const FAILING_NOTICES: readonly Notice['kind'][] = ['unreachable', 'endpoint-missing', 'config-error', 'timeout'];

const invalidEntries = ({ entries }: PanelState): Entry[] => entries.filter(({ status }) => status === 'invalid');
const failingNotices = ({ notices }: PanelState): Notice[] => notices.filter(({ kind }) => FAILING_NOTICES.includes(kind));

export function reportStatus(state: PanelState, mode: TestMode): ReportStatus {
  if (invalidEntries(state).length === 0 && failingNotices(state).length === 0) return 'passed';
  return mode === 'error' ? 'failed' : 'warning';
}

function describeEntry({ method, url, operation, operationUrl, errors }: Entry): string[] {
  const matched = operation ? ` -> ${operation.method} ${operation.path} (${operationUrl})` : '';
  return [`${method} ${url}${matched}`, ...errors.map(({ location, message }) => `  ${location}: ${message}`)];
}

// The headline counts the invalid responses only, the other failing results follow with their panel text.
export function errorMessage(state: PanelState): string {
  const invalid = invalidEntries(state);
  const verb = invalid.length === 1 ? 'response does' : 'responses do';
  const headline = invalid.length === 0 ? [] : [`Mokapi: ${invalid.length} ${verb} not match the contract.`, ''];
  return [...headline, ...invalid.flatMap(describeEntry), ...failingNotices(state).map(({ message }) => message)].join('\n');
}

// The labels of the entry kinds, in the order the panel counts them.
export const KIND_LABELS: Record<Entry['status'], string> = {
  valid: 'valid',
  invalid: 'invalid',
  'not-in-contract': 'not in contract',
  unreachable: 'Mokapi not reachable',
};

export function countLine(entries: Entry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const validated = `${entries.length} ${entries.length === 1 ? 'response' : 'responses'} validated`;
  const kinds = (Object.keys(KIND_LABELS) as Entry['status'][])
    .map((kind) => ({ kind, count: entries.filter(({ status }) => status === kind).length }))
    .filter(({ count }) => count > 0)
    .map(({ kind, count }) => `${count} ${KIND_LABELS[kind]}`);
  return [validated, ...kinds].join(', ');
}

// The headline is the first line of the message; the entries below show the details. Storybook's status description and the panel use it.
const headline = (message: string): string => message.split('\n')[0];

// A passed report has nothing to say beyond its badge.
export const reportHeadline = (report: Report | undefined): string | undefined =>
  report === undefined || report.status === 'passed' ? undefined : headline(report.message);

// The names are Storybook's theme colors, as the Interactions panel's status badge uses them.
export interface ReportBadge {
  label: 'PASS' | 'WARN' | 'FAIL' | 'WAIT';
  status: 'positive' | 'warning' | 'negative' | 'mediumdark';
}

const REPORT_BADGES: Record<ReportStatus, ReportBadge> = {
  passed: { label: 'PASS', status: 'positive' },
  warning: { label: 'WARN', status: 'warning' },
  failed: { label: 'FAIL', status: 'negative' },
};

// `testMode` is set while validation is on: until the report exists the story is still validating.
export function reportBadge(testMode: TestMode | undefined, report: Report | undefined): ReportBadge | undefined {
  if (testMode === undefined || testMode === 'off') return undefined;
  return report === undefined ? { label: 'WAIT', status: 'mediumdark' } : REPORT_BADGES[report.status];
}

// The panel shows at most this many characters of a body; Mokapi gets the whole body.
export const BODY_LIMIT = 10_000;

export const truncateBody = (text: string): { body: string; truncated: boolean } =>
  ({ body: text.slice(0, BODY_LIMIT), truncated: text.length > BODY_LIMIT });

export function formatBody(text: string): string {
  if (text === '') return '(empty)';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export const STATUS_TYPE_ID = 'mokapi/validation';

// A passed check has no status, so that a story only shows an icon when there is something to look at.
export function sidebarStatus(storyId: string, report: Report | undefined): Status | undefined {
  if (report === undefined || report.status === 'passed') return undefined;
  return {
    typeId: STATUS_TYPE_ID,
    storyId,
    title: 'Mokapi',
    value: report.status === 'failed' ? 'status-value:error' : 'status-value:warning',
    description: headline(report.message),
  };
}
