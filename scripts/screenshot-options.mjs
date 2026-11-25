// The pure parts of scripts/screenshot.mjs: command line, shot selection and output paths.
import { parseArgs } from 'node:util';
import { join } from 'node:path';

export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      only: { type: 'string' },
      theme: { type: 'string', default: 'light' },
      'docs-dir': { type: 'string' },
    },
  });
  if (values.theme !== 'light' && values.theme !== 'dark') {
    throw new Error(`Unknown --theme ${values.theme}, use light or dark`);
  }
  return { only: values.only, theme: values.theme, docsDir: values['docs-dir'] };
}

// --only is a substring of the shot name or of its file.
export function selectShots(shots, only) {
  return shots.filter((shot) => !only || shot.name.includes(only) || shot.file.includes(only));
}

// The panel's box cut off below its content: full width, from the top down to contentBottom plus margin,
// but never below the panel's own bottom edge.
export function clipBelowContent(panel, contentBottom, margin = 16) {
  const height = Math.min(panel.height, contentBottom + margin - panel.y);
  return { x: panel.x, y: panel.y, width: panel.width, height };
}

// Shots go to the docs directory, without --docs-dir to the output directory.
// A shot with `readme` is copied into the addon's own docs folder for the README.
export function outputFiles(shot, { docsDir, outDir, readmeDir }) {
  const directory = docsDir ?? outDir;
  const files = [join(directory, shot.file)];
  if (shot.readme) files.push(join(readmeDir, shot.file));
  return files;
}
