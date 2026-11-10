// Storybook only renders a story again when a global changes, so a component that fetches on mount
// would not request anything. After a switch of `mokapiValidation` the story is remounted, but only
// once it has finished: remounting a story that is still rendering makes Storybook reload the preview.
export interface RemountState {
  validation?: unknown;
  /** The story to remount when it has finished rendering. */
  pending?: string;
}

export type RemountEvent =
  | { type: 'initial'; validation: unknown }
  | { type: 'switched'; validation: unknown; storyId?: string }
  | { type: 'finished'; storyId: string }
  | { type: 'story-changed' };

export const initialRemountState: RemountState = {};

export function nextRemount(state: RemountState, event: RemountEvent): { state: RemountState; remount?: string } {
  switch (event.type) {
    case 'initial':
      return { state: { validation: event.validation } };
    case 'switched': {
      const changed = state.validation !== undefined && state.validation !== event.validation;
      return { state: { validation: event.validation, pending: changed ? event.storyId : state.pending } };
    }
    case 'finished':
      return event.storyId === state.pending
        ? { state: { validation: state.validation }, remount: event.storyId }
        : { state };
    case 'story-changed':
      return { state: { validation: state.validation } };
  }
}
