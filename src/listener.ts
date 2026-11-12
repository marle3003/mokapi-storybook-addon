import {
  errorMessage,
  INVALID_TEST_PARAMETER_MESSAGE,
  operationUrl,
  QUIET_WINDOW_MAX_MS,
  QUIET_WINDOW_MS,
  reportStatus,
  resolveTestMode,
  timeoutMessage,
  VALIDATION_TIMEOUT_MS,
} from './report.js';
import { initialPanelState, reducePanel, type Entry, type PanelAction, type PanelState } from './results.js';
import type { MokapiStoryParameters, TestMode } from './types.js';
import { classify, sendValidation, serializePair, type ValidationOutcome } from './validation.js';

const WORKER_MISSING = 'MSW worker not found: `context.msw` is missing. Use `mswLoader` or set `context.msw` in your loader.';

interface StartedRequest {
  request: Request;
  requestId: string;
}

interface MockedResponse extends StartedRequest {
  response: Response;
}

// The part of MSW's worker (or server) the addon needs. The addon imports nothing from MSW.
interface MswWorker {
  events: {
    on(event: 'request:start' | 'request:unhandled' | 'unhandledException', listener: (started: StartedRequest) => void): unknown;
    on(event: 'response:mocked' | 'response:bypass', listener: (mocked: MockedResponse) => void): unknown;
  };
}

export interface HookContext {
  id: string;
  globals: Record<string, unknown>;
  parameters: { mokapi?: Omit<MokapiStoryParameters, 'test'> & { test?: unknown } };
  msw?: unknown;
  /** One per mount: Storybook keeps it for the re-renders of a mount and creates a new one for every mount. */
  abortSignal?: AbortSignal;
}

// What Storybook adds to the context for afterEach: the render's abort signal and the reporting API.
export interface TestContext extends HookContext {
  abortSignal: AbortSignal;
  reporting: { addReport(report: { type: string; version: number; status: string; result: unknown }): void };
}

export interface HookOptions {
  emit: (action: PanelAction) => void;
  dashboardUrl: string;
  defaultTest: TestMode;
}

// A request that MSW started and that Mokapi has not validated yet, which afterEach waits for.
interface InFlight {
  label: string;
  done: Promise<void>;
  finish: () => void;
  finished: boolean;
}

// The state of one mount of a story: its panel list, test mode and requests in flight. Re-renders share it.
interface Render {
  renderId: number;
  api?: string;
  /** Validation is on for this story (also without a worker, which is then reported in the panel). */
  validating: boolean;
  /** Requests are sent to Mokapi, i.e. validating and a worker to listen to. */
  sending: boolean;
  mode: TestMode;
  /** What the panel shows for this render, so the report holds exactly that. */
  state: PanelState;
  inFlight: Map<string, InFlight>;
  /** Set while afterEach waits for the quiet window. */
  onRequestStart?: () => void;
}

// The listener lives as long as the worker, the story changes with every render: each hook run
// replaces this slot and the listener reads it.
let current: Render = newRender(0, { validating: false, sending: false, mode: 'off' });
// A component may fetch again after a render, so the response can arrive when the next render has
// already started. The request belongs to the render that was current when it started.
const startedIn = new Map<string, Render>();
// Storybook passes the same context object to beforeEach and afterEach.
// After a throwing handler MSW answers with its own 500 and emits `response:mocked` for it: that
// response is not the project's mock, so it is not validated.
const thrownRequests = new Set<string>();
const rendersOfContext = new WeakMap<HookContext, Render>();
// Results belong to a mount, not to a render: a re-render (globals or args changed) runs the hooks again
// with a new context but the same abortSignal, and keeps the Render of the mount.
const rendersOfMount = new WeakMap<AbortSignal, Render>();
let renderCount = 0;
let capturedCount = 0;
const observedWorkers = new WeakSet<object>();

function newRender(renderId: number, { api, validating, sending, mode }: Pick<Render, 'api' | 'validating' | 'sending' | 'mode'>): Render {
  return { renderId, api, validating, sending, mode, state: initialPanelState, inFlight: new Map() };
}

const isWorker = (msw: unknown): msw is MswWorker =>
  typeof (msw as MswWorker | undefined)?.events?.on === 'function';

// Everything the panel learns about a render also goes into the render's own state.
function announce(render: Render, emit: HookOptions['emit'], action: PanelAction): void {
  render.state = reducePanel(render.state, action);
  emit(action);
}

const describeRequest = ({ method, url }: Request): string => {
  const { pathname, search } = new URL(url);
  return `${method} ${pathname}${search}`;
};

function trackInFlight(render: Render, { request, requestId }: StartedRequest): void {
  let finish = () => {};
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const inFlight: InFlight = {
    label: describeRequest(request),
    done,
    finished: false,
    finish: () => {
      inFlight.finished = true;
      render.inFlight.delete(requestId);
      finish();
    },
  };
  render.inFlight.set(requestId, inFlight);
}

function onRequestStart(started: StartedRequest): void {
  startedIn.set(started.requestId, current);
  if (current.sending) trackInFlight(current, started);
  current.onRequestStart?.();
}

// MSW passes the request on or its handler threw: no response will be validated.
function dropRequest({ requestId }: StartedRequest): void {
  startedIn.get(requestId)?.inFlight.get(requestId)?.finish();
  startedIn.delete(requestId);
}

function onUnhandledException(started: StartedRequest): void {
  dropRequest(started);
  thrownRequests.add(started.requestId);
}

// A Mokapi that cannot be reached is listed per request and, once, as notice.
function toPanelActions(
  outcome: ValidationOutcome,
  renderId: number,
  request: Omit<Entry, 'status' | 'errors'>,
  dashboardUrl: string,
): PanelAction[] {
  if (!('message' in outcome)) {
    const operation = 'operation' in outcome ? outcome.operation : undefined;
    const matched = operation && { operation, operationUrl: operationUrl(dashboardUrl, operation) };
    return [{ type: 'result', renderId, entry: { ...request, status: outcome.status, errors: outcome.errors, ...matched } }];
  }
  const notice: PanelAction = { type: 'notice', renderId, notice: { kind: outcome.status, message: outcome.message } };
  if (outcome.status !== 'unreachable') return [notice];
  const entry: Entry = { ...request, status: 'unreachable', errors: [], message: outcome.message };
  return [{ type: 'result', renderId, entry }, notice];
}

function validate({ request, response, requestId }: MockedResponse, { emit, dashboardUrl }: HookOptions): void {
  if (thrownRequests.delete(requestId)) return;
  const render = startedIn.get(requestId) ?? current;
  const inFlight = render.inFlight.get(requestId);
  startedIn.delete(requestId);
  if (!render.sending) return;
  const sequence = ++capturedCount;
  const time = Date.now();
  // Cloned now: the application gets the original pair and may read it any moment.
  void serializePair(request.clone(), response.clone(), render.api).then(async (payload) => {
    const settle = (answer: unknown) => classify(dashboardUrl, answer);
    const outcome = await sendValidation(dashboardUrl, payload).then(settle, settle);
    toPanelActions(outcome, render.renderId, {
      sequence,
      time,
      method: payload.request.method,
      url: payload.request.url,
      statusCode: payload.response.statusCode,
    }, dashboardUrl).forEach((action) => announce(render, emit, action));
  }).finally(() => inFlight?.finish());
}

function observe(worker: MswWorker, options: HookOptions): void {
  if (observedWorkers.has(worker)) return;
  observedWorkers.add(worker);
  worker.events.on('request:start', onRequestStart);
  worker.events.on('response:mocked', (mocked) => validate(mocked, options));
  worker.events.on('response:bypass', dropRequest);
  worker.events.on('request:unhandled', dropRequest);
  worker.events.on('unhandledException', onUnhandledException);
}

// Runs before every story render and never throws: it runs for every story of the project.
// A mount starts a new Render and a new panel list, a re-render continues the Render of its mount.
export function validationHook(context: HookContext, options: HookOptions): void {
  const { api, disable, test } = context.parameters.mokapi ?? {};
  const validating = context.globals.mokapiValidation === 'on' && !disable;
  // A switch of the validation re-renders before the addon remounts: that render must not judge the old results.
  const mounted = context.abortSignal && rendersOfMount.get(context.abortSignal);
  if (mounted?.validating === validating) {
    current = mounted;
    rendersOfContext.set(context, mounted);
    return;
  }
  const { mode, invalid } = resolveTestMode(test, options.defaultTest);
  const worker = isWorker(context.msw) ? context.msw : undefined;
  const render = newRender(++renderCount, { api, validating, sending: validating && worker !== undefined, mode });
  current = render;
  rendersOfContext.set(context, render);
  if (context.abortSignal) rendersOfMount.set(context.abortSignal, render);
  const emit = (action: PanelAction) => announce(render, options.emit, action);

  if (validating || worker !== undefined) {
    emit({ type: 'render-started', storyId: context.id, renderId: render.renderId, ...(validating && { testMode: mode }) });
  }
  if (validating && invalid) emit({ type: 'notice', renderId: render.renderId, notice: { kind: 'config-error', message: INVALID_TEST_PARAMETER_MESSAGE } });
  if (worker !== undefined) return observe(worker, options);
  if (validating) emit({ type: 'notice', renderId: render.renderId, notice: { kind: 'worker-missing', message: WORKER_MISSING } });
}

type Outcome = 'finished' | 'timeout' | 'aborted';

// Resolves when no request has started for QUIET_WINDOW_MS, at the latest after QUIET_WINDOW_MAX_MS.
function untilQuiet(render: Render): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const cap = setTimeout(done, QUIET_WINDOW_MAX_MS);
    function done(): void {
      clearTimeout(quiet);
      clearTimeout(cap);
      render.onRequestStart = undefined;
      resolve();
    }
    const restart = () => {
      clearTimeout(quiet);
      quiet = setTimeout(done, QUIET_WINDOW_MS);
    };
    render.onRequestStart = restart;
    restart();
  });
}

const untilAborted = (abortSignal: AbortSignal): Promise<Outcome> => new Promise((resolve) => {
  if (abortSignal.aborted) resolve('aborted');
  abortSignal.addEventListener('abort', () => resolve('aborted'), { once: true });
});

// Runs after every story: waits for the validations and reports the result to Storybook. In error mode
// a failing result throws, so Storybook shows its error display and finishes the story with status error.
// The 4 s limit counts from the start, the quiet window included.
export async function testHook(context: TestContext, options: HookOptions): Promise<void> {
  const render = rendersOfContext.get(context);
  if (render === undefined || !render.validating || render.mode === 'off') return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Outcome>((resolve) => { timer = setTimeout(() => resolve('timeout'), VALIDATION_TIMEOUT_MS); });
  const aborted = untilAborted(context.abortSignal);
  try {
    const quiet = await Promise.race([untilQuiet(render).then((): Outcome => 'finished'), aborted]);
    // Storybook reloads the preview when a render that is torn down is still pending.
    if (quiet === 'aborted') return;
    const waiting = [...render.inFlight.values()];
    const validated = Promise.all(waiting.map(({ done }) => done)).then((): Outcome => 'finished');
    const outcome = await Promise.race([validated, timeout, aborted]);
    if (outcome === 'aborted') return;
    if (outcome === 'timeout') {
      waiting.filter(({ finished }) => !finished).forEach(({ label }) => announce(render, options.emit, {
        type: 'notice',
        renderId: render.renderId,
        notice: { kind: 'timeout', message: timeoutMessage(label) },
      }));
    }
  } finally {
    clearTimeout(timer);
  }

  const status = reportStatus(render.state, render.mode);
  const { entries, notices } = render.state;
  context.reporting.addReport({ type: 'mokapi', version: 1, status, result: { entries, notices } });
  if (status === 'failed') throw new Error(errorMessage(render.state));
}
