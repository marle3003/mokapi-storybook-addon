import { createStoryScenarios } from 'mokapi-storybook-addon/msw';
import { Profile } from './Profile';
import { scenarios as profileScenarios } from './mocks/profile';

const scenarios = createStoryScenarios(profileScenarios, { api: 'Profile API' });

export default { title: 'Profile', component: Profile, tags: ['autodocs'] };

export const Success = { parameters: scenarios.success };
export const Invalid = { parameters: scenarios.invalid };
