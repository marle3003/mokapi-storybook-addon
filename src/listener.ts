import type { Entry, PanelAction } from './results.js';
import type { MokapiStoryParameters } from './types.js';
import { classify, sendValidation, serializePair, type ValidationOutcome } from './validation.js';

const MOCKED_RESPONSE_EVENT = 'response:mocked';
const WORKER_MISSING = 'MSW worker not found: `context.msw` is missing. Use `mswLoader` or set `context.msw` in your loader.';

interface MockedResponse {
  request: Request;
  response: Response;
}

// The part of MSW's worker (or server) the addon needs. The addon imports nothing from MSW.
interface MswWorker {
  events: { on(event: typeof MOCKED_RESPONSE_EVENT, listener: (mocked: MockedResponse) => void): unknown };
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

// The listener lives as long as the worker, the story changes with every render: each hook run
// overwrites this slot and the listener reads it.
let current: { renderId: number; api?: string; sending: boolean } = { renderId: 0, sending: false };
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

function validate({ request, response }: MockedResponse, { emit, dashboardUrl }: HookOptions): void {
  if (!current.sending) return;
  const { renderId, api } = current;
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
    worker.events.on(MOCKED_RESPONSE_EVENT, (mocked) => validate(mocked, options));
  }
}
