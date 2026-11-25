// Storybook only renders a story again when a global changes, so a component that fetches on mount
// would not request anything. After a switch of `mokapiValidation` the story is remounted, but only
// once the re-render that the switch caused has finished: remounting a story that is still rendering
// makes Storybook reload the preview. Phase events of the same story carry the same `renderId` for the
// old render and the re-render, so the order of the events is what tells them apart. Every render ends
// with one `finished`, so `open` counts the `started` without their `finished` per story and the remount
// waits until the last of them has finished. These orders occur:
//   enqueued:                  switched, finished(old), started, finished(new)
//   immediate, running render: switched, started, finished(old), finished(new)
//   immediate, settled render: switched, started, finished
//   second switch, immediate:  switched, started(1), switched, started(2), finished(old), finished(1), finished(2)
//                              (observed on Storybook 10.6.7, e2e "switching validation twice while the old
//                              render is still finishing ...")
//   second switch, enqueued:   switched, started(1), switched, finished(1), started(2), finished(2)
//   second switch after the old render finished, observed on Storybook 10.6.7:
//                              switched, started(1), finished(old), switched, started(2), finished(1), finished(2)
// A switch resets `rendering`, so a `finished` that comes before the start of the latest re-render never
// remounts. Remaining edge cases: `aborted` is not tracked (a render that ended only by `aborted` still
// emits `finished`), and a switch that reaches the manager before the phase events it follows can miss
// one remount.
export interface RemountState {
  validation?: unknown;
  /** Renders per story that have started and not finished yet. */
  open: Record<string, number>;
  /** The story to remount when the re-render after a switch has finished. */
  pending?: string;
  /** The latest re-render has started. */
  rendering?: boolean;
}

export type RemountEvent =
  | { type: 'initial'; validation: unknown }
  | { type: 'switched'; validation: unknown; storyId?: string }
  | { type: 'started'; storyId: string }
  | { type: 'finished'; storyId: string }
  | { type: 'story-changed' };

export const initialRemountState: RemountState = { open: {} };

function openRenders(state: RemountState, storyId: string): number {
  return state.open[storyId] ?? 0;
}

function withOpenRenders(state: RemountState, storyId: string, count: number): RemountState {
  return { ...state, open: { ...state.open, [storyId]: Math.max(0, count) } };
}

export function nextRemount(state: RemountState, event: RemountEvent): { state: RemountState; remount?: string } {
  switch (event.type) {
    case 'initial':
      return { state: { validation: event.validation, open: {} } };
    case 'switched': {
      const changed = state.validation !== undefined && state.validation !== event.validation;
      return {
        state: changed
          ? { validation: event.validation, open: state.open, pending: event.storyId }
          : { ...state, validation: event.validation },
      };
    }
    case 'started':
      return {
        state: {
          ...withOpenRenders(state, event.storyId, openRenders(state, event.storyId) + 1),
          rendering: state.rendering || event.storyId === state.pending,
        },
      };
    case 'finished': {
      const next = withOpenRenders(state, event.storyId, openRenders(state, event.storyId) - 1);
      const lastRenderFinished = event.storyId === state.pending && state.rendering && openRenders(next, event.storyId) === 0;
      return lastRenderFinished
        ? { state: { validation: state.validation, open: next.open }, remount: event.storyId }
        : { state: next };
    }
    case 'story-changed':
      return { state: { validation: state.validation, open: {} } };
  }
}

// The manager's selection changes on the click, before its STORY_CHANGED arrives, so a pending remount can
// belong to a story that was left in the meantime. Storybook would render it next to the newly selected story.
export function remountIfSelected(remount: string | undefined, selectedStoryId: string | undefined): string | undefined {
  return remount === selectedStoryId ? remount : undefined;
}
