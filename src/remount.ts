// Storybook only renders a story again when a global changes, so a component that fetches on mount
// would not request anything. After a switch of `mokapiValidation` the story is remounted, but only
// once the render that started after the switch has finished: remounting a story that is still
// rendering makes Storybook reload the preview. A render that was running at the switch is skipped,
// because Storybook enqueues the re-render and starts it after that render has finished. Phase events
// of the same story carry the same `renderId` for both, so the order of the events is what tells them apart.
// (A switch while the story is playing, where the re-render starts at once, remounts after the first `finished` that follows.)
export interface RemountState {
  validation?: unknown;
  /** The story waiting for the first render that starts after the switch. */
  pending?: string;
  /** The story to remount when that render has finished. */
  rendering?: string;
}

export type RemountEvent =
  | { type: 'initial'; validation: unknown }
  | { type: 'switched'; validation: unknown; storyId?: string }
  | { type: 'started'; storyId: string }
  | { type: 'finished'; storyId: string }
  | { type: 'story-changed' };

export const initialRemountState: RemountState = {};

export function nextRemount(state: RemountState, event: RemountEvent): { state: RemountState; remount?: string } {
  switch (event.type) {
    case 'initial':
      return { state: { validation: event.validation } };
    case 'switched': {
      const changed = state.validation !== undefined && state.validation !== event.validation;
      return { state: { validation: event.validation, pending: changed ? event.storyId : state.pending, rendering: changed ? undefined : state.rendering } };
    }
    case 'started':
      return event.storyId === state.pending
        ? { state: { validation: state.validation, rendering: event.storyId } }
        : { state };
    case 'finished':
      return event.storyId === state.rendering
        ? { state: { validation: state.validation }, remount: event.storyId }
        : { state };
    case 'story-changed':
      return { state: { validation: state.validation } };
  }
}
