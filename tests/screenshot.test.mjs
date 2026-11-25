import assert from 'node:assert/strict';
import test from 'node:test';
import { clipBelowContent, outputFiles, parseOptions, selectShots } from '../scripts/screenshot-options.mjs';

const shots = [
  { name: 'hero', file: 'screenshot.png', readme: true },
  { name: 'partial', file: 'partial.png' },
  { name: 'request-invalid', file: 'request-invalid.png' },
];
const folders = { docsDir: undefined, outDir: '/out', readmeDir: '/addon/docs' };

test('parseOptions uses the light theme and no docs directory by default', () => {
  assert.deepEqual(parseOptions([]), { only: undefined, theme: 'light', docsDir: undefined });
});

test('parseOptions reads --only, --theme and --docs-dir', () => {
  assert.deepEqual(
    parseOptions(['--only', 'partial', '--theme', 'dark', '--docs-dir', '../docs']),
    { only: 'partial', theme: 'dark', docsDir: '../docs' },
  );
});

test('parseOptions rejects an unknown theme', () => {
  assert.throws(() => parseOptions(['--theme', 'blue']), /Unknown --theme blue, use light or dark/);
});

test('selectShots returns every shot without --only', () => {
  assert.deepEqual(selectShots(shots, undefined), shots);
});

test('selectShots matches a part of the name', () => {
  assert.deepEqual(selectShots(shots, 'request').map((shot) => shot.name), ['request-invalid']);
});

test('selectShots matches a part of the file', () => {
  assert.deepEqual(selectShots(shots, 'screenshot.png').map((shot) => shot.name), ['hero']);
});

test('selectShots returns nothing when no shot matches', () => {
  assert.deepEqual(selectShots(shots, 'nothing'), []);
});

test('outputFiles writes a docs shot to the docs directory', () => {
  assert.deepEqual(outputFiles(shots[1], { ...folders, docsDir: '/mokapi/docs' }), ['/mokapi/docs/partial.png']);
});

test('outputFiles writes a docs shot to the output directory without a docs directory', () => {
  assert.deepEqual(outputFiles(shots[1], folders), ['/out/partial.png']);
});

test('outputFiles copies the README shot into the addon docs', () => {
  assert.deepEqual(outputFiles(shots[0], { ...folders, docsDir: '/mokapi/docs' }), [
    '/mokapi/docs/screenshot.png',
    '/addon/docs/screenshot.png',
  ]);
});

test('clipBelowContent keeps the panel width and ends a margin below the content', () => {
  const panel = { x: 700, y: 0, width: 324, height: 640 };
  assert.deepEqual(clipBelowContent(panel, 300), { x: 700, y: 0, width: 324, height: 316 });
});

test('clipBelowContent counts from the panel top', () => {
  const panel = { x: 0, y: 100, width: 500, height: 400 };
  assert.deepEqual(clipBelowContent(panel, 250, 20), { x: 0, y: 100, width: 500, height: 170 });
});

test('clipBelowContent never exceeds the panel height', () => {
  const panel = { x: 0, y: 0, width: 500, height: 400 };
  assert.equal(clipBelowContent(panel, 900).height, 400);
});
