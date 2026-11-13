// The stories that have a render in progress: a `loading` phase without its `finished` yet. The panel
// disables Rerun for them, because remounting a pending story makes Storybook reload the preview.
export type Rendering = ReadonlySet<string>;

export type RenderingEvent = { type: 'started' | 'finished'; storyId: string };

export const initialRendering: Rendering = new Set();

export function nextRendering(rendering: Rendering, { type, storyId }: RenderingEvent): Rendering {
  const next = new Set(rendering);
  if (type === 'started') next.add(storyId);
  else next.delete(storyId);
  return next;
}

export const isRendering = (rendering: Rendering, storyId: string): boolean => rendering.has(storyId);
