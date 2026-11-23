/** What a story with a failing validation result does: fail (`error`), report a warning (`warning`) or nothing (`off`). */
export type TestMode = 'error' | 'warning' | 'off';

export interface MokapiAddonOptions {
  dashboardUrl?: string;
  defaultValidation?: boolean;
  /** Test mode of all stories, `parameters.mokapi.test` overrides it. Default `warning`. */
  defaultTest?: TestMode;
  /**
   * Validates the stories' responses with partial responses: Mokapi doesn't report missing properties in the response
   * body, but still checks everything the body contains. `parameters.mokapi.partial` overrides it. Default `false`.
   */
  defaultPartial?: boolean;
  /**
   * Milliseconds the Mokapi afterEach waits for the responses of a story and their validation, the quiet window
   * included. `parameters.mokapi.timeout` overrides it. Default `4000`.
   */
  defaultTimeout?: number;
}

export type ResolvedAddonOptions = Required<MokapiAddonOptions>;

export interface MokapiStoryParameters {
  /**
   * `info.title` of the OpenAPI contract the story's requests belong to. Without it, Mokapi
   * searches all APIs and reports a request that several APIs match as not in contract.
   */
  api?: string;
  /** Sends nothing to Mokapi for this story. */
  disable?: boolean;
  /** Overrides `defaultTest` for this story. */
  test?: TestMode;
  /** Overrides `defaultPartial` for this story. */
  partial?: boolean;
  /** Overrides `defaultTimeout` for this story, in milliseconds. */
  timeout?: number;
}
