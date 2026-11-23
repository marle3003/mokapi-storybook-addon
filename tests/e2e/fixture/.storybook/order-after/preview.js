// A story with `parameters.mokapiOrderCheck` fails when the Mokapi report already exists, i.e. when the Mokapi
// afterEach ran before this addon's afterEach. Mokapi adds its report at the end of its hook.
export const afterEach = (context) => {
  if (!context.parameters.mokapiOrderCheck) return;
  if (context.reporting.reports.some(({ type }) => type === 'mokapi')) {
    throw new Error('The Mokapi afterEach ran before the afterEach of the addon listed after it.');
  }
};
