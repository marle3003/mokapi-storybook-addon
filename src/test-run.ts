import { isTestMode } from './options.js';
import { CONTRACT_ERROR_PREFIX, headline } from './report.js';
import { invalidCount, resultsOfStory, validCount, type Entry, type Notice, type PanelState, type Report } from './results.js';
import type { TestMode } from './types.js';

// What the addon reads of the `CurrentRun` that @storybook/addon-vitest publishes when a run is over. It is
// typed here on purpose: addon-vitest is no dependency of this addon.
export interface TestRunPayload {
  componentTestStatuses: { storyId: string; description?: string }[];
  reports: Record<string, { type: string; version?: unknown; status?: unknown; result?: unknown }[] | undefined>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// addon-vitest is no dependency of this addon and may change its payload, so the manager reads it only when it has
// the shape this file reads.
export const readTestRun = (payload: unknown): TestRunPayload | undefined =>
  isRecord(payload)
  && Array.isArray(payload.componentTestStatuses) && payload.componentTestStatuses.every((status) => isRecord(status) && typeof status.storyId === 'string' && (status.description === undefined || typeof status.description === 'string'))
  && isRecord(payload.reports) && Object.values(payload.reports).every((reports) => reports === undefined || (Array.isArray(reports) && reports.every(isRecord)))
    ? (payload as unknown as TestRunPayload)
    : undefined;

// The event comes from addon-vitest too, so its type and payload are read the same careful way and never throw.
export const readTestRunEvent = (event: unknown): TestRunPayload | undefined =>
  isRecord(event) && event.type === 'test-run-completed' ? readTestRun(event.payload) : undefined;

/** What the last test run found out about a story: its Mokapi report with the entries and notices behind it. */
export interface StoryRun {
  report: Report;
  entries: Entry[];
  notices: Notice[];
  testMode?: TestMode;
}

export type StoryRuns = Readonly<Record<string, StoryRun>>;

type RunReport = NonNullable<TestRunPayload['reports'][string]>[number];

// addon-vitest keeps the reports of a story only when its test passed, so a failed story is known by its error
// text alone, which starts with `CONTRACT_ERROR_PREFIX`.
const isResult = (result: unknown): result is { entries: Entry[]; notices: Notice[]; testMode?: unknown } =>
  typeof result === 'object' && result !== null && 'entries' in result && Array.isArray(result.entries) && 'notices' in result && Array.isArray(result.notices);

// A passed report is a result only with a valid response: without one the story was skipped and has nothing to show.
function runOfReport(reports: RunReport[] = []): StoryRun | undefined {
  const report = reports.find(({ type, version }) => type === 'mokapi' && version === 1);
  if (report === undefined || (report.status !== 'passed' && report.status !== 'warning' && report.status !== 'failed') || !isResult(report.result)) return undefined;
  const { entries, notices, testMode } = report.result;
  const valid = validCount(report.result);
  if (report.status === 'passed' && valid === 0) return undefined;
  return { report: { status: report.status, headline: headline(report.result), invalid: invalidCount(report.result), valid }, entries, notices, ...(isTestMode(testMode) && { testMode }) };
}

// A contract error fails the story only in test mode `error`.
function runOfError(description = ''): StoryRun | undefined {
  const start = description.indexOf(CONTRACT_ERROR_PREFIX);
  if (start < 0) return undefined;
  const failed = description.slice(start + CONTRACT_ERROR_PREFIX.length).split('\n')[0];
  return { report: { status: 'failed', headline: failed, invalid: 0, valid: 0 }, entries: [], notices: [], testMode: 'error' };
}

// A story took part in the run when it has a component test status: stories without a Mokapi report (validation
// off, `disable`, mode `off`) are in it, `Object.keys(reports)` would miss them.
export const ranStoryIds = ({ componentTestStatuses }: TestRunPayload): string[] =>
  componentTestStatuses.map(({ storyId }) => storyId);

// A skipped story (passed without a valid response) has no result: there is nothing to show for it.
export const testRunResults = (payload: TestRunPayload): StoryRuns => Object.fromEntries(
  payload.componentTestStatuses.flatMap(({ storyId, description }) => {
    const run = runOfReport(payload.reports[storyId]) ?? runOfError(description);
    return run === undefined ? [] : [[storyId, run]];
  }),
);

// The stories of the run get their new result or none, the other stories keep theirs.
export function applyTestRun(runs: StoryRuns, payload: TestRunPayload): StoryRuns {
  const ran = new Set(ranStoryIds(payload));
  const outside = Object.entries(runs).filter(([storyId]) => !ran.has(storyId));
  return { ...Object.fromEntries(outside), ...testRunResults(payload) };
}

export function forgetStoryRun(runs: StoryRuns, storyId: string): StoryRuns {
  if (!Object.hasOwn(runs, storyId)) return runs;
  return Object.fromEntries(Object.entries(runs).filter(([id]) => id !== storyId));
}

// A report belongs to its mount. When the mount started before a test run, its report is older than the run even
// though it arrives later and must not replace the run result. A report of a mount that started after the run (or of
// a re-render, which has no mount of its own) is newer. So the manager tracks the validating mounts that have not
// reported yet, and which of them a run has overtaken.
export type Mounts = Readonly<Record<string, 'validating' | 'overtaken'>>;

// A new mount forgets the mark of an older one, e.g. one that was aborted and never reported.
export const startValidatingMount = (mounts: Mounts, storyId: string): Mounts => ({ ...mounts, [storyId]: 'validating' });

export function overtakeMounts(mounts: Mounts, payload: TestRunPayload): Mounts {
  const overtaken = ranStoryIds(payload).filter((storyId) => Object.hasOwn(mounts, storyId));
  if (overtaken.length === 0) return mounts;
  return { ...mounts, ...Object.fromEntries(overtaken.map((storyId) => [storyId, 'overtaken'])) };
}

// Without its test runs there is nothing left to overtake: the pending report counts again.
export const releaseOvertaken = (mounts: Mounts): Mounts =>
  Object.fromEntries(Object.keys(mounts).map((storyId) => [storyId, 'validating']));

/** The report ends the mount. `overtaken` tells that a test run is newer than it. */
export function settleReport(mounts: Mounts, storyId: string): { mounts: Mounts; overtaken: boolean } {
  if (!Object.hasOwn(mounts, storyId)) return { mounts, overtaken: false };
  const { [storyId]: state, ...pending } = mounts;
  return { mounts: pending, overtaken: state === 'overtaken' };
}

export type StoryPanel = PanelState & { fromTestRun?: true };

// The result of the last test run wins over the UI state: the manager drops it when the UI reports newer results.
export function panelOf(ui: PanelState, runs: StoryRuns, storyId: string): StoryPanel {
  if (!Object.hasOwn(runs, storyId)) return resultsOfStory(ui, storyId);
  const { report, entries, notices, testMode } = runs[storyId];
  return { storyId, renderId: 0, entries, notices, report, ...(testMode && { testMode }), fromTestRun: true };
}
