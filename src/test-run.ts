import { isTestMode } from './options.js';
import { CONTRACT_ERROR_PREFIX, headline } from './report.js';
import { resultsOfStory, type Entry, type Notice, type PanelState, type Report } from './results.js';
import type { TestMode } from './types.js';

// What the addon reads of the `CurrentRun` that @storybook/addon-vitest publishes when a run is over. It is
// typed here on purpose: addon-vitest is no dependency of this addon.
export interface TestRunPayload {
  componentTestStatuses: { storyId: string; description?: string }[];
  reports: Record<string, { type: string; version?: unknown; status?: unknown; result?: unknown }[] | undefined>;
}

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

function runOfReport(reports: RunReport[] = []): StoryRun | undefined {
  const report = reports.find(({ type, version }) => type === 'mokapi' && version === 1);
  if (report === undefined || (report.status !== 'warning' && report.status !== 'failed') || !isResult(report.result)) return undefined;
  const { entries, notices, testMode } = report.result;
  return { report: { status: report.status, headline: headline(report.result) }, entries, notices, ...(isTestMode(testMode) && { testMode }) };
}

// A contract error fails the story only in test mode `error`.
function runOfError(description = ''): StoryRun | undefined {
  const start = description.indexOf(CONTRACT_ERROR_PREFIX);
  if (start < 0) return undefined;
  const failed = description.slice(start + CONTRACT_ERROR_PREFIX.length).split('\n')[0];
  return { report: { status: 'failed', headline: failed }, entries: [], notices: [], testMode: 'error' };
}

// A story took part in the run when it has a component test status: stories without a Mokapi report (validation
// off, `disable`, mode `off`) are in it, `Object.keys(reports)` would miss them.
export const ranStoryIds = ({ componentTestStatuses }: TestRunPayload): string[] =>
  componentTestStatuses.map(({ storyId }) => storyId);

// A passed story has no result: there is nothing to show for it.
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

export type StoryPanel = PanelState & { fromTestRun?: true };

// The result of the last test run wins over the UI state: the manager drops it when the UI reports newer results.
export function panelOf(ui: PanelState, runs: StoryRuns, storyId: string): StoryPanel {
  if (!Object.hasOwn(runs, storyId)) return resultsOfStory(ui, storyId);
  const { report, entries, notices, testMode } = runs[storyId];
  return { storyId, renderId: 0, entries, notices, report, ...(testMode && { testMode }), fromTestRun: true };
}
