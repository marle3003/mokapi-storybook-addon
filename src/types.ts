/** What a story with a failing validation result does: fail (`error`), report a warning (`warning`) or nothing (`off`). */
export type TestMode = 'error' | 'warning' | 'off';

export interface MokapiAddonOptions {
  dashboardUrl?: string;
  defaultValidation?: boolean;
  /** Test mode of all stories, `parameters.mokapi.test` overrides it. Default `warning`. */
  defaultTest?: TestMode;
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
}
