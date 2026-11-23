import { fileURLToPath } from 'node:url';

// A stand-in for another addon: it only adds its preview annotation, like the addons the Mokapi hook has to follow.
export const previewAnnotations = (entries = []) => [...entries, fileURLToPath(new URL('./preview.js', import.meta.url))];
