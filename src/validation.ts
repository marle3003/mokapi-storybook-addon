const VALIDATE_PATH = '/api/services/http/validate';
const MINIMUM_MOKAPI_VERSION = '0.58.0';
const PARTIAL_MINIMUM_MOKAPI_VERSION = '0.60.0';

export interface ValidationPayload {
  api?: string;
  partialResponse?: true;
  request: { method: string; url: string; headers: Record<string, string>; body: string };
  response: { statusCode: number; headers: Record<string, string>; body: string };
}

export interface ValidationError {
  location: string;
  schema?: string;
  message: string;
}

/** The contract operation Mokapi matched; `path` is the template of the contract, e.g. `/profile/{id}`. */
export interface Operation {
  api: string;
  method: string;
  path: string;
}

// Results carry Mokapi's errors, the other outcomes a notice message for the panel.
// A result of a partial request that lacks the echo of `partialResponse` carries the notice text: that Mokapi
// ignored the option.
export type ValidationOutcome =
  | { status: 'valid' | 'invalid'; errors: ValidationError[]; operation?: Operation; partialUnsupportedMessage?: string }
  | { status: 'not-in-contract'; errors: ValidationError[]; partialUnsupportedMessage?: string }
  | { status: 'unreachable' | 'endpoint-missing' | 'config-error'; message: string };

type ResultOutcome = Extract<ValidationOutcome, { errors: ValidationError[] }>;

export const unreadableMessage = (error: unknown): string =>
  `Mokapi: could not read the mocked request or response: ${error instanceof Error ? error.message : String(error)}`;

// A body that was already consumed or cannot be read must not stop the validation.
async function readText(message: Request | Response): Promise<string> {
  try {
    return await message.text();
  } catch {
    return '';
  }
}

// The origin is left out: Mokapi finds the operation from method and path like for a real request.
export async function serializePair(request: Request, response: Response, api?: string, partial = false): Promise<ValidationPayload> {
  const { pathname, search } = new URL(request.url);
  const [requestBody, responseBody] = await Promise.all([readText(request), readText(response)]);
  return {
    ...(api !== undefined && { api }),
    ...(partial && { partialResponse: true as const }),
    request: {
      method: request.method,
      url: `${pathname}${search}`,
      headers: Object.fromEntries(request.headers),
      body: requestBody,
    },
    response: {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers),
      body: responseBody,
    },
  };
}

// text/plain keeps this a CORS simple request, so no preflight is sent. Mokapi decodes the body as
// JSON anyway, and a Mokapi without the endpoint still answers with a readable 405.
// `Accept: msw/passthrough` is the marker of MSW's own bypass(): the project's worker passes the request on
// without calling onUnhandledRequest, and the service worker strips the value. Accept is safelisted, so the
// request stays a simple one.
export function sendValidation(dashboardUrl: string, payload: ValidationPayload): Promise<Response> {
  return fetch(`${dashboardUrl}${VALIDATE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', Accept: 'msw/passthrough' },
    body: JSON.stringify(payload),
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

const messageOf = (body: unknown): string | undefined =>
  typeof (body as { message?: unknown })?.message === 'string' ? (body as { message: string }).message : undefined;

// Mokapi reports an operation it cannot find (or cannot choose) as the error with location "operation".
function classifyResult(errors: ValidationError[], operation?: Operation): ResultOutcome {
  if (errors.length > 0 && errors[0].location === 'operation') return { status: 'not-in-contract', errors };
  return { status: errors.length === 0 ? 'valid' : 'invalid', errors, ...(operation && { operation }) };
}

// Mokapi echoes `partialResponse: true` when it applied the option; an older Mokapi ignores it silently.
function withPartialCheck(outcome: ResultOutcome, body: unknown, dashboardUrl: string): ResultOutcome {
  if ((body as { partialResponse?: unknown }).partialResponse === true) return outcome;
  return {
    ...outcome,
    partialUnsupportedMessage: `The Mokapi at ${dashboardUrl} doesn't support partial responses and must be updated to ${PARTIAL_MINIMUM_MOKAPI_VERSION}.`,
  };
}

export async function classify(dashboardUrl: string, answer: Response | unknown, partialRequested = false): Promise<ValidationOutcome> {
  if (!(answer instanceof Response)) {
    return {
      status: 'unreachable',
      message: `Mokapi is not reachable at ${dashboardUrl}. Check the dashboardUrl option and that Mokapi is running.`,
    };
  }
  const body = await readJson(answer);
  const endpointMissing: ValidationOutcome = {
    status: 'endpoint-missing',
    message: `Mokapi at ${dashboardUrl} does not support ${VALIDATE_PATH}. Update Mokapi to ${MINIMUM_MOKAPI_VERSION}.`,
  };
  if (answer.ok) {
    if (!Array.isArray((body as { errors?: unknown })?.errors)) return endpointMissing;
    const outcome = classifyResult((body as { errors: ValidationError[] }).errors, (body as { operation?: Operation }).operation);
    return partialRequested ? withPartialCheck(outcome, body, dashboardUrl) : outcome;
  }
  const message = messageOf(body);
  // A 404 with Mokapi's JSON message names an unknown API, without it the endpoint does not exist.
  if (answer.status === 404 && message !== undefined) return { status: 'config-error', message };
  if (message === undefined && (answer.status === 404 || answer.status === 405)) return endpointMissing;
  return {
    status: 'config-error',
    message: `Mokapi answered HTTP ${answer.status}${message === undefined ? '' : `: ${message}`}`,
  };
}
