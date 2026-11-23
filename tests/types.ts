import type { MokapiAddonOptions, TestMode } from 'mokapi-storybook-addon';
import type { Parameters } from 'storybook/internal/csf';
// @ts-expect-error The ./msw entry (createMokapiLoader, createStoryScenarios) was removed.
import type {} from 'mokapi-storybook-addon/msw';

const options: MokapiAddonOptions = { dashboardUrl: 'http://localhost:8080', defaultValidation: true };
void options;
const failingOptions: MokapiAddonOptions = { defaultTest: 'error' };
void failingOptions;
const testMode: TestMode = 'off';
void testMode;
const partialOptions: MokapiAddonOptions = { defaultPartial: true };
void partialOptions;
const timeoutOptions: MokapiAddonOptions = { defaultTimeout: 8000 };
void timeoutOptions;
const defaultOptions: MokapiAddonOptions = {};
void defaultOptions;

const withApi: Parameters = { mokapi: { api: 'Profile API' } };
void withApi;
const disabled: Parameters = { mokapi: { disable: true } };
void disabled;
const withTest: Parameters = { mokapi: { test: 'warning' } };
void withTest;
const withPartial: Parameters = { mokapi: { partial: true } };
void withPartial;
const withTimeout: Parameters = { mokapi: { timeout: 10000 } };
void withTimeout;
const empty: Parameters = { mokapi: {} };
void empty;

// @ts-expect-error The addon no longer forwards requests to a target.
const withTarget: MokapiAddonOptions = { target: 'http://localhost:3000' };
void withTarget;
// @ts-expect-error defaultValidation is a boolean.
const stringValidation: MokapiAddonOptions = { defaultValidation: 'on' };
void stringValidation;
// @ts-expect-error The mock backend toggle was replaced by defaultValidation.
const withBackend: MokapiAddonOptions = { defaultBackend: 'mokapi' };
void withBackend;
// @ts-expect-error Scenarios were removed.
const withScenario: Parameters = { mokapi: { scenario: 'success' } };
void withScenario;
// @ts-expect-error Routes were removed.
const withRoutes: Parameters = { mokapi: { routes: ['/api/profile'] } };
void withRoutes;
// @ts-expect-error disable is a boolean.
const stringDisable: Parameters = { mokapi: { disable: 'yes' } };
void stringDisable;
// @ts-expect-error defaultTest is 'error', 'warning' or 'off'.
const strictDefaultTest: MokapiAddonOptions = { defaultTest: 'strict' };
void strictDefaultTest;
// @ts-expect-error test is 'error', 'warning' or 'off'.
const strictTest: Parameters = { mokapi: { test: 'strict' } };
void strictTest;
// @ts-expect-error The test mode todo was renamed to warning.
const todoDefaultTest: MokapiAddonOptions = { defaultTest: 'todo' };
void todoDefaultTest;
// @ts-expect-error The test mode todo was renamed to warning.
const todoTest: Parameters = { mokapi: { test: 'todo' } };
void todoTest;
// @ts-expect-error TestMode is a union of strings, not a boolean.
const booleanTestMode: TestMode = true;
void booleanTestMode;
// @ts-expect-error defaultPartial is a boolean.
const stringDefaultPartial: MokapiAddonOptions = { defaultPartial: 'yes' };
void stringDefaultPartial;
// @ts-expect-error partial is a boolean.
const stringPartial: Parameters = { mokapi: { partial: 'yes' } };
void stringPartial;
// @ts-expect-error defaultTimeout is a number of milliseconds.
const stringDefaultTimeout: MokapiAddonOptions = { defaultTimeout: '4000' };
void stringDefaultTimeout;
// @ts-expect-error timeout is a number of milliseconds.
const stringTimeout: Parameters = { mokapi: { timeout: '10000' } };
void stringTimeout;
