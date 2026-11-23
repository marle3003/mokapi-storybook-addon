import { isPositiveNumber, isTestMode } from './options.js';
import type { Status, StatusesByStoryIdAndTypeId } from 'storybook/internal/types';
import type { Entry, Notice, PanelState, Report, ReportStatus } from './results.js';
import type { TestMode } from './types.js';
import type { Operation } from './validation.js';

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

export const INVALID_TEST_PARAMETER_MESSAGE = "Mokapi: parameters.mokapi.test must be 'error', 'warning' or 'off'.";
export const INVALID_PARTIAL_PARAMETER_MESSAGE = 'Mokapi: parameters.mokapi.partial must be true or false.';

export const INVALID_TIMEOUT_PARAMETER_MESSAGE = 'Mokapi: parameters.mokapi.timeout must be a positive number.';

// 4000 is `4 s`, 1500 is `1.5 s`.
const seconds = (timeoutMs: number): string => `${timeoutMs / 1000} s`;

const LIMIT_OPTIONS = 'parameters.mokapi.timeout or defaultTimeout';

// `request` is the method and path with query, e.g. `GET /api/profile/1`.
// MSW delivered a response and Mokapi has not judged it in time.
export const timeoutMessage = (request: string, timeoutMs: number): string =>
  `Mokapi validation did not finish within ${seconds(timeoutMs)} (${request}). Increase ${LIMIT_OPTIONS}.`;

// The handler has not answered in time, which is on purpose for a loading skeleton: nothing was validated.
export const handlerTimeoutMessage = (request: string, timeoutMs: number): string =>
  `No response from the MSW handler within ${seconds(timeoutMs)} (${request}), not validated. If the response is delayed on purpose, increase ${LIMIT_OPTIONS}.`;

// An invalid value falls back to the project default; the caller reports it as configuration error.
export function resolveTestMode(parameter: unknown, defaultTest: TestMode): { mode: TestMode; invalid: boolean } {
  if (parameter === undefined) return { mode: defaultTest, invalid: false };
  return isTestMode(parameter) ? { mode: parameter, invalid: false } : { mode: defaultTest, invalid: true };
}

// An invalid value falls back to the project default; the caller reports it as configuration error.
export function resolvePartial(parameter: unknown, defaultPartial: boolean): { partial: boolean; invalid: boolean } {
  if (parameter === undefined) return { partial: defaultPartial, invalid: false };
  return typeof parameter === 'boolean' ? { partial: parameter, invalid: false } : { partial: defaultPartial, invalid: true };
}

// An invalid value falls back to the project default; the caller reports it as configuration error.
export function resolveTimeout(parameter: unknown, defaultTimeout: number): { timeout: number; invalid: boolean } {
  if (parameter === undefined) return { timeout: defaultTimeout, invalid: false };
  return isPositiveNumber(parameter) ? { timeout: parameter, invalid: false } : { timeout: defaultTimeout, invalid: true };
}

const TEST_MODE_TEXTS: Record<TestMode, string> = {
  error: 'Test mode: error. Contract errors make this story fail.',
  warning: 'Test mode: warning. Contract errors are reported as warnings, the story stays green.',
  off: 'Test mode: off. Contract errors are shown here only.',
};

export const testModeText = (mode: TestMode): string => TEST_MODE_TEXTS[mode];

// A PASS of a partial story doesn't mean the mock is complete, so the panel says so.
export const PARTIAL_TEXT = 'Partial responses: missing properties are not checked.';

// Not in contract, a missing worker and a handler that never answers are shown in the panel only: a project with
// partial contracts or loading skeleton stories would get a warning on every story otherwise.
const FAILING_NOTICES: readonly Notice['kind'][] = ['unreachable', 'endpoint-missing', 'config-error', 'timeout', 'partial-unsupported'];

export const isFailingNotice = (kind: Notice['kind']): boolean => FAILING_NOTICES.includes(kind);

type Results = Pick<PanelState, 'entries' | 'notices'>;

const invalidEntries = ({ entries }: Results): Entry[] => entries.filter(({ status }) => status === 'invalid');
const failingNotices = ({ notices }: Results): Notice[] => notices.filter(({ kind }) => isFailingNotice(kind));

export function reportStatus(state: Results, mode: TestMode): ReportStatus {
  if (invalidEntries(state).length === 0 && failingNotices(state).length === 0) return 'passed';
  return mode === 'error' ? 'failed' : 'warning';
}

function describeEntry({ method, url, operation, operationUrl, errors }: Entry): string[] {
  const matched = operation ? ` -> ${operation.method} ${operation.path} (${operationUrl})` : '';
  return [`${method} ${url}${matched}`, ...errors.map(({ location, message }) => `  ${location}: ${message}`)];
}

// The panel, the sidebar status and the error show this headline. It counts the invalid responses; without one the
// first failing notice speaks for itself. Empty when nothing fails.
export function headline(state: Results): string {
  const invalid = invalidEntries(state);
  if (invalid.length === 0) return failingNotices(state)[0]?.message ?? '';
  return `${invalid.length} ${invalid.length === 1 ? 'response does' : 'responses do'} not match the contract.`;
}

// A failed test names Mokapi with this text, which also tells Mokapi's failure from any other in a test run.
export const CONTRACT_ERROR_PREFIX = 'Mokapi contract validation failed: ';

// Thrown under Vitest, which prints this text for the failed test: the headline comes first, the details follow.
export function errorMessage(state: Results): string {
  const invalid = invalidEntries(state);
  const notices = failingNotices(state).map(({ message }) => message);
  // The first notice is the headline when no response is invalid.
  const details = [...invalid.flatMap(describeEntry), ...(invalid.length === 0 ? notices.slice(1) : notices)];
  return [`${CONTRACT_ERROR_PREFIX}${headline(state)}`, ...(details.length === 0 ? [] : ['', ...details])].join('\n');
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

// The report and the status store are untyped at runtime, so only a positive integer counts as a count.
const isPositiveCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

// A passed report alone doesn't say that anything was checked: without a valid response it was skipped. The count is
// the one of the report, so the badge, the sidebar status and the test result agree, also when a response arrives later.
const isSkipped = (report: Report): boolean => report.status === 'passed' && !isPositiveCount(report.valid);

export const SKIP_HEADLINE = 'No response was checked against the contract.';

// A report that passed with a valid response has nothing to say beyond its badge. A skip names a missing worker or a
// handler that did not answer, which are no failures, so the generic text would hide the cause.
export function reportHeadline(report: Report | undefined, { notices }: Pick<PanelState, 'notices'>): string | undefined {
  if (report === undefined) return undefined;
  if (isSkipped(report)) return notices.find(({ kind }) => kind === 'worker-missing' || kind === 'handler-timeout')?.message ?? SKIP_HEADLINE;
  return report.status === 'passed' ? undefined : report.headline;
}

// The names are Storybook's theme colors, as the Interactions panel's status badge uses them.
export interface ReportBadge {
  label: 'PASS' | 'PARTIAL' | 'WARN' | 'FAIL' | 'WAIT' | 'SKIP';
  status: 'positive' | 'warning' | 'negative' | 'mediumdark';
}

const REPORT_BADGES: Record<ReportStatus, ReportBadge> = {
  passed: { label: 'PASS', status: 'positive' },
  warning: { label: 'WARN', status: 'warning' },
  failed: { label: 'FAIL', status: 'negative' },
};

const PARTIAL_BADGE: ReportBadge = { label: 'PARTIAL', status: 'positive' };

// `testMode` is set while validation is on: until the report exists the story is still validating.
// A passed partial story is PARTIAL instead of PASS; its report status stays passed.
export function reportBadge(testMode: TestMode | undefined, report: Report | undefined, partial = false): ReportBadge | undefined {
  if (testMode === undefined || testMode === 'off') return undefined;
  if (report === undefined) return { label: 'WAIT', status: 'mediumdark' };
  if (isSkipped(report)) return { label: 'SKIP', status: 'mediumdark' };
  return partial && report.status === 'passed' ? PARTIAL_BADGE : REPORT_BADGES[report.status];
}

// The names are Storybook's theme colors, used by the status and the method badge.
export type BadgeColor = 'positive' | 'secondary' | 'warning' | 'negative' | 'mediumdark' | 'gold';

// The status groups are the ones of the dashboard's `getClassByStatusCode`.
// Keyed by the hundreds digit of the status code.
const STATUS_GROUPS: Record<number, { name: string; color: BadgeColor }> = {
  1: { name: 'Informational', color: 'mediumdark' },
  2: { name: 'Success', color: 'positive' },
  3: { name: 'Redirect', color: 'secondary' },
  4: { name: 'Client error', color: 'warning' },
  5: { name: 'Server error', color: 'negative' },
};

// The codes of RFC 9110 (with its names) and the common ones of other RFCs.
const STATUS_TEXTS: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols',
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information', 204: 'No Content',
  205: 'Reset Content', 206: 'Partial Content',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  305: 'Use Proxy', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout',
  409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Content Too Large',
  414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 417: 'Expectation Failed',
  418: "I'm a teapot", 421: 'Misdirected Request', 422: 'Unprocessable Content', 425: 'Too Early',
  426: 'Upgrade Required', 429: 'Too Many Requests', 431: 'Request Header Fields Too Large',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout', 505: 'HTTP Version Not Supported', 511: 'Network Authentication Required',
};

// 0 (`HttpResponse.error()`) and anything else outside 100-599 has no group.
const statusGroup = (code: number) => Number.isInteger(code) ? STATUS_GROUPS[Math.floor(code / 100)] : undefined;

export const statusColor = (code: number): BadgeColor => statusGroup(code)?.color ?? 'mediumdark';

// The colors of the dashboard's method badges (`http.css`). A `Map`, so `constructor` doesn't find a property of `Object`.
const METHOD_COLORS = new Map<string, BadgeColor>([
  ['GET', 'secondary'], ['OPTIONS', 'secondary'],
  ['POST', 'positive'],
  ['PUT', 'warning'], ['PATCH', 'warning'],
  ['DELETE', 'negative'],
  ['HEAD', 'gold'], ['TRACE', 'gold'],
]);

// `fetch` keeps the case of a method it doesn't normalize (`patch`).
export const methodColor = (method: string): BadgeColor => METHOD_COLORS.get(method.toUpperCase()) ?? 'mediumdark';

export const statusText = (code: number): string | undefined => STATUS_TEXTS[code] ?? statusGroup(code)?.name;

// The accessible name of the status badge.
export const statusLabel = (code: number): string => [code, statusText(code)].filter((part) => part !== undefined).join(' ');

const twoDigits = (value: number): string => String(value).padStart(2, '0');

// Always 24-hour, whatever the browser locale, like a log line.
export function formatTime(time: number): string {
  const date = new Date(time);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(twoDigits).join(':');
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

export const PASSED_TEXT = 'All responses match the contract.';

const SIDEBAR_VALUES: Record<ReportStatus, Status['value']> = {
  passed: 'status-value:success',
  warning: 'status-value:warning',
  failed: 'status-value:error',
};

// A passed report with a valid response is a success, so the sidebar shows that Mokapi checked the story. A skipped
// report (passed without a valid count) and a story without a report have no status: nothing was checked.
export function sidebarStatus(storyId: string, report: Report | undefined): Status | undefined {
  if (report === undefined || isSkipped(report)) return undefined;
  return {
    typeId: STATUS_TYPE_ID,
    storyId,
    title: 'Mokapi',
    value: SIDEBAR_VALUES[report.status],
    description: report.status === 'passed' ? PASSED_TEXT : report.headline,
    // The context menu reads the number from the status store, which outlives the panel state of a browser reload.
    data: { invalid: report.invalid },
    // Storybook lists a status in the top group of the context menu unless the status opts out. Like addon-vitest,
    // Mokapi shows its status in the section of its test provider instead.
    sidebarContextMenu: false,
  };
}

export interface ContextMenuRow {
  value: 'status-value:unknown' | 'status-value:success' | 'status-value:warning' | 'status-value:error';
  /** The accessible name of the row's button. */
  label: string;
  tooltip: string;
  /** The number of invalid responses behind an error or warning; 0 shows no number. */
  invalid: number;
  /** The story the button opens; without one the button is disabled. */
  target?: string;
}

type RowValue = ContextMenuRow['value'];

// Worst first. Other values (pending, unknown, made up by another version) are no result.
const RESULT_VALUES: RowValue[] = ['status-value:error', 'status-value:warning', 'status-value:success'];

const isFailing = (value: Status['value']): boolean => value === 'status-value:error' || value === 'status-value:warning';

// The tooltip is the text of a component, a group or a story whose status has no headline.
const CONTEXT_MENU_TEXTS: Record<RowValue, { label: string; tooltip: string }> = {
  'status-value:error': { label: 'Mokapi: Error', tooltip: 'Contract validation failed' },
  'status-value:warning': { label: 'Mokapi: Warning', tooltip: 'Contract validation has warnings' },
  'status-value:success': { label: 'Mokapi: Passed', tooltip: PASSED_TEXT },
  'status-value:unknown': { label: 'Mokapi: No result', tooltip: 'Validate with Mokapi or run tests to see results' },
};

// `data` is untyped and the store is shared, so anything but a count of invalid responses is no count.
function invalidCountOf({ data }: Status): number {
  const invalid = data?.invalid;
  return isPositiveCount(invalid) ? invalid : 0;
}

const invalidLabel = (label: string, invalid: number): string =>
  invalid > 0 ? `${label} (${invalid} invalid ${invalid === 1 ? 'response' : 'responses'})` : label;

// The Contract row over some stories: the worst Mokapi status wins, the number is the sum of the failing stories'
// invalid responses and the button opens the first story (in the order of `storyIds`) of the winning status.
// A single story shows its own headline as tooltip, when the caller asks for it.
function contractRow(
  storyIds: readonly string[],
  statuses: StatusesByStoryIdAndTypeId,
  withStoryTooltip: boolean,
): ContextMenuRow {
  const leaves = storyIds.flatMap((storyId) => {
    const status = statuses[storyId]?.[STATUS_TYPE_ID];
    return status ? [{ storyId, status }] : [];
  });
  const value = RESULT_VALUES.find((candidate) => leaves.some(({ status }) => status.value === candidate));
  if (value === undefined) return { value: 'status-value:unknown', ...CONTEXT_MENU_TEXTS['status-value:unknown'], invalid: 0 };
  const [{ storyId, status }] = leaves.filter((leaf) => leaf.status.value === value);
  const invalid = leaves.filter((leaf) => isFailing(leaf.status.value)).reduce((sum, leaf) => sum + invalidCountOf(leaf.status), 0);
  const { label, tooltip } = CONTEXT_MENU_TEXTS[value];
  return {
    value,
    label: invalidLabel(label, invalid),
    tooltip: (withStoryTooltip && isFailing(value) && status.description) || tooltip,
    invalid,
    target: storyId,
  };
}

// The row "Contract" in the sidebar's context menu, like addon-vitest's Interactions row: every story, component and
// group has one, a docs entry has none. A component or group aggregates its leaf stories.
export function contextMenuRow(
  entry: { type: string; id: string },
  leafStoryIds: readonly string[],
  statuses: StatusesByStoryIdAndTypeId,
): ContextMenuRow | undefined {
  if (entry.type === 'docs') return undefined;
  return contractRow(leafStoryIds, statuses, entry.type === 'story');
}

// The row "Contract" in the Run tests widget: all stories of the Storybook, the tooltips are the fixed texts.
export const widgetRow = (storyIds: readonly string[], statuses: StatusesByStoryIdAndTypeId): ContextMenuRow =>
  contractRow(storyIds, statuses, false);

// The checkbox in the widget only shows whether a test run checks contracts, it can't be switched there.
export const contractCheckboxTooltip = (defaultValidation: boolean): string =>
  defaultValidation
    ? 'Contract validation runs with the tests (defaultValidation is on).'
    : 'Contract validation is off in test runs. Set defaultValidation: true to check contracts.';
