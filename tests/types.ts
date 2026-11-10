import type { MokapiAddonOptions } from 'mokapi-storybook-addon';
import type { Parameters } from 'storybook/internal/csf';
// @ts-expect-error The ./msw entry (createMokapiLoader, createStoryScenarios) was removed.
import type {} from 'mokapi-storybook-addon/msw';

const options: MokapiAddonOptions = { dashboardUrl: 'http://localhost:8080', defaultValidation: true };
void options;
const defaultOptions: MokapiAddonOptions = {};
void defaultOptions;

const withApi: Parameters = { mokapi: { api: 'Profile API' } };
void withApi;
const disabled: Parameters = { mokapi: { disable: true } };
void disabled;
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
