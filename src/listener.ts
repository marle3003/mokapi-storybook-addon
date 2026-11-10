import type { Entry, PanelAction } from './results.js';
import type { MokapiStoryParameters } from './types.js';
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
    on(event: 'request:start', listener: (started: StartedRequest) => void): unknown;
    on(event: 'response:mocked', listener: (mocked: MockedResponse) => void): unknown;
  };
}

export interface HookContext {
  id: string;
  globals: Record<string, unknown>;
  parameters: { mokapi?: MokapiStoryParameters };
  msw?: unknown;
}

export interface HookOptions {
  emit: (action: PanelAction) => void;
  dashboardUrl: string;
}

interface Render {
  renderId: number;
  api?: string;
  sending: boolean;
}

// The listener lives as long as the worker, the story changes with every render: each hook run
// replaces this slot and the listener reads it.
let current: Render = { renderId: 0, sending: false };
// A component may fetch again after a render, so the response can arrive when the next render has
// already started. The request belongs to the render that was current when it started.
const startedIn = new Map<string, Render>();
let renderCount = 0;
let capturedCount = 0;
const observedWorkers = new WeakSet<object>();

const isWorker = (msw: unknown): msw is MswWorker =>
  typeof (msw as MswWorker | undefined)?.events?.on === 'function';

// A Mokapi that cannot be reached is listed per request and, once, as notice.
function toPanelActions(outcome: ValidationOutcome, renderId: number, request: Omit<Entry, 'status' | 'errors'>): PanelAction[] {
  if (!('message' in outcome)) {
    return [{ type: 'result', renderId, entry: { ...request, status: outcome.status, errors: outcome.errors } }];
  }
  const notice: PanelAction = { type: 'notice', renderId, notice: { kind: outcome.status, message: outcome.message } };
  if (outcome.status !== 'unreachable') return [notice];
  const entry: Entry = { ...request, status: 'unreachable', errors: [], message: outcome.message };
  return [{ type: 'result', renderId, entry }, notice];
}

function validate({ request, response, requestId }: MockedResponse, { emit, dashboardUrl }: HookOptions): void {
  const { renderId, api, sending } = startedIn.get(requestId) ?? current;
  startedIn.delete(requestId);
  if (!sending) return;
  const sequence = ++capturedCount;
  const time = Date.now();
  // Cloned now: the application gets the original pair and may read it any moment.
  void serializePair(request.clone(), response.clone(), api).then(async (payload) => {
    const settle = (answer: unknown) => classify(dashboardUrl, answer);
    const outcome = await sendValidation(dashboardUrl, payload).then(settle, settle);
    toPanelActions(outcome, renderId, {
      sequence,
      time,
      method: payload.request.method,
      url: payload.request.url,
      statusCode: payload.response.statusCode,
    }).forEach(emit);
  });
}

// Runs before every story render and never throws: it runs for every story of the project.
export function validationHook(context: HookContext, options: HookOptions): void {
  const { api, disable } = context.parameters.mokapi ?? {};
  const validating = context.globals.mokapiValidation === 'on' && !disable;
  const renderId = ++renderCount;
  const worker = isWorker(context.msw) ? context.msw : undefined;
  current = { renderId, api, sending: validating && worker !== undefined };

  if (worker === undefined) {
    if (validating) {
      options.emit({ type: 'render-started', storyId: context.id, renderId });
      options.emit({ type: 'notice', renderId, notice: { kind: 'worker-missing', message: WORKER_MISSING } });
    }
    return;
  }
  options.emit({ type: 'render-started', storyId: context.id, renderId });
  if (!observedWorkers.has(worker)) {
    observedWorkers.add(worker);
    worker.events.on('request:start', ({ requestId }) => startedIn.set(requestId, current));
    worker.events.on('response:mocked', (mocked) => validate(mocked, options));
  }
}
