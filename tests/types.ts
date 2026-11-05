import { graphql, http, HttpResponse } from 'msw';
import { createMokapiLoader, createStoryScenarios } from 'mokapi-storybook-addon/msw';
import type { MokapiAddonOptions } from 'mokapi-storybook-addon';
import { mswLoader } from 'msw-storybook-addon/csf3';
import type { LoaderFunction } from 'storybook/internal/types';
import type { Parameters } from 'storybook/internal/csf';

const loader: LoaderFunction = createMokapiLoader(mswLoader());
void loader;

const scenarios = createStoryScenarios({
  success: [http.get('/api/profile', () => HttpResponse.json({}))],
  serverError: [http.get('/api/profile', () => HttpResponse.json({}, { status: 500 }))],
});

const name: 'success' = scenarios.success.mokapi.scenario;
void name;
const storyParameters: Parameters = { mokapi: scenarios.success.mokapi };
void storyParameters;
const options: MokapiAddonOptions = { target: 'http://localhost:3000', proxyPath: '/custom-mokapi' };
void options;

// @ts-expect-error target has no default and must be set.
const withoutTarget: MokapiAddonOptions = { proxyPath: '/custom-mokapi' };
void withoutTarget;
// @ts-expect-error Unknown scenario names must not be accepted.
void scenarios.sucess;
// @ts-expect-error The selected scenario retains its literal name.
const wrongName: 'serverError' = scenarios.success.mokapi.scenario;
void wrongName;
// @ts-expect-error Only MSW HTTP handlers are supported.
createStoryScenarios({ invalid: [graphql.query('Profile', () => HttpResponse.json({}))] });
