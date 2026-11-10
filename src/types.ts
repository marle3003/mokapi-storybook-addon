export interface MokapiAddonOptions {
  dashboardUrl?: string;
  defaultValidation?: boolean;
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
}
