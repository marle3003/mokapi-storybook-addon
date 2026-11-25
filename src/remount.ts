// Storybook only renders a story again when a global changes, so a component that fetches on mount
// would not request anything. After a switch of `mokapiValidation` the story is remounted, but only
// once the re-render that the switch caused has finished: remounting a story that is still rendering
// makes Storybook reload the preview. Phase events of the same story carry the same `renderId` for the
// old render and the re-render, so the order of the events is what tells them apart. Three orders occur:
//   enqueued:                  switched, finished(old), started, finished(new)
//   immediate, running render: switched, started, finished(old), finished(new)
//   immediate, settled render: switched, started, finished
// Storybook enqueues the re-render while the story is pending and starts it at once otherwise, so
// `running` (a `started` without its `finished`) tells at the switch whether one `finished` of the old
// render is still to come. A second switch while the re-render of the pending story still runs skips
// that re-render's `finished` the same way, although `running` may already be cleared by the `finished`
// of the old render. Remaining edge cases: three or more switches within one render are not counted
// (only one `finished` is skipped), and `aborted` is not tracked, so a render that ended only
// by `aborted` leaves `running` set until the next phase event, and a switch that reaches the manager
// before the phase events it follows can miss one remount.
export interface RemountState {
  validation?: unknown;
  /** The story that is running a render (`started` without `finished`). */
  running?: string;
  /** The story to remount when the re-render after a switch has finished. */
  pending?: string;
  /** A render that was running at the switch has not finished yet; its `finished` is not the re-render's. */
  oldRenderRunning?: boolean;
  /** The re-render has started. */
  rendering?: boolean;
}

export type RemountEvent =
  | { type: 'initial'; validation: unknown }
  | { type: 'switched'; validation: unknown; storyId?: string }
  | { type: 'started'; storyId: string }
  | { type: 'finished'; storyId: string }
  | { type: 'story-changed' };

export const initialRemountState: RemountState = {};

// A `finished` of this story is still to come: a render is running, or the re-render of an earlier switch is.
function isRenderOpen(state: RemountState, storyId: string | undefined): boolean {
  return state.running === storyId || (state.pending === storyId && state.rendering === true);
}

export function nextRemount(state: RemountState, event: RemountEvent): { state: RemountState; remount?: string } {
  switch (event.type) {
    case 'initial':
      return { state: { validation: event.validation } };
    case 'switched': {
      const changed = state.validation !== undefined && state.validation !== event.validation;
      return {
        state: changed
          ? { validation: event.validation, running: state.running, pending: event.storyId, oldRenderRunning: isRenderOpen(state, event.storyId) }
          : { ...state, validation: event.validation },
      };
    }
    case 'started':
      return { state: { ...state, running: event.storyId, rendering: state.rendering || event.storyId === state.pending } };
    case 'finished': {
      const idle = { ...state, running: state.running === event.storyId ? undefined : state.running };
      if (event.storyId !== state.pending) return { state: idle };
      if (state.oldRenderRunning) return { state: { ...idle, oldRenderRunning: false } };
      return state.rendering
        ? { state: { validation: state.validation }, remount: event.storyId }
        : { state: idle };
    }
    case 'story-changed':
      return { state: { validation: state.validation } };
  }
}

// The manager's selection changes on the click, before its STORY_CHANGED arrives, so a pending remount can
// belong to a story that was left in the meantime. Storybook would render it next to the newly selected story.
export function remountIfSelected(remount: string | undefined, selectedStoryId: string | undefined): string | undefined {
  return remount === selectedStoryId ? remount : undefined;
}
