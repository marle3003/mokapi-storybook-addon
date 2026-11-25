// The shot list of scripts/screenshot.mjs, data only. A shot is:
// - name, file: what --only matches, and the PNG it writes
// - readme: also copied into the addon's docs folder for the README
// - story: the story id; params: the manager URL parameters (layout of the Storybook UI)
// - testMode: the addon's defaultTest of the Storybook instance ('warning' unless the shot says otherwise)
// - viewport, deviceScaleFactor: 1024x640 at 2x unless the shot says otherwise
// - clip: 'panel' or 'sidebar' to crop to that region, otherwise the whole page
// - visitAllStories: opens every story first, the sidebar status exists only for rendered stories
// - expect: the panel state to wait for. badge: text of the report badge, text: shown in the panel,
//   entries: number of entries
const PANEL_ID = 'mokapi/validation';

const DOCS_VIEWPORT = { width: 1024, height: 640 };

// Sidebar hidden, Mokapi panel on the right.
const panelOnly = { nav: 0, panel: 'right', addonPanel: PANEL_ID, shortcuts: 0 };
const withSidebar = { panel: 'right', addonPanel: PANEL_ID, shortcuts: 0 };

const ENUM_ERROR = "value 'shipped' does not match one in the enumeration [pending, in_transit, delivered]";
const NAME_ERROR = 'required properties are missing: firstName, lastName';
const REQUEST_ERROR = 'invalid type, expected integer but got string';
const NOT_IN_CONTRACT = 'no operation found for GET /v1/orders/1';

const docs = { viewport: DOCS_VIEWPORT, deviceScaleFactor: 2, params: panelOnly, testMode: 'warning' };

export const shots = [
  {
    ...docs,
    name: 'hero',
    file: 'screenshot.png',
    readme: true,
    story: 'orders--enum-changed',
    expect: { badge: 'WARN', text: ENUM_ERROR },
  },
  {
    ...docs,
    name: 'partial',
    file: 'partial.png',
    story: 'orders--partial',
    expect: { badge: 'PARTIAL', text: 'Partial responses: missing properties are not checked.' },
  },
  {
    ...docs,
    name: 'panel-entries',
    file: 'panel-entries.png',
    story: 'orders--order-page',
    viewport: { width: 1024, height: 900 },
    clip: 'panel',
    expect: { badge: 'WARN', entries: 3, text: NOT_IN_CONTRACT },
  },
  {
    ...docs,
    name: 'request-invalid',
    file: 'request-invalid.png',
    story: 'orders--request-bug',
    clip: 'panel',
    expect: { badge: 'WARN', text: REQUEST_ERROR },
  },
  {
    ...docs,
    name: 'sidebar-status',
    file: 'sidebar-status.png',
    story: 'orders--valid',
    params: withSidebar,
    testMode: 'error',
    visitAllStories: true,
    clip: 'sidebar',
    expect: { badge: 'PASS' },
  },
  {
    ...docs,
    name: 'error-message',
    file: 'error-message.png',
    story: 'orders--renamed-field',
    testMode: 'error',
    clip: 'panel',
    expect: { badge: 'FAIL', text: NAME_ERROR },
  },
];
