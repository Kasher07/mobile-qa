// Maestro flows the widget step (runner/app-widgets.mjs) generates, and its junit. Pure; tested in
// test/app-qa-widgets.test.mjs. The iOS flows drive SpringBoard (English iPhone 17 Pro simulator, iOS 26.5) with the
// labels in LABELS. Three probes (2026-11-26) showed: Maestro sees and taps SpringBoard, but its longPressOn does nothing
// on the home screen (it works on the lock screen); a zero-length 2.5 s swipe on a dock icon opens the icon menu with
// "Edit Home Screen"; the lock-screen editor shows "ADD WIDGETS". The steps after the icon menu (Edit > Add Widget >
// the app's pages) have not run yet: the iOS widget step is unproven (README, "Home-screen widgets").

export const LABELS = {
  editHome: 'Edit Home Screen', // icon menu item (seen)
  edit: 'Edit', // top-left button in jiggle mode (not seen yet)
  addWidget: 'Add Widget', // Edit menu item and the gallery's button (not seen yet)
  customize: 'Customize', // lock-screen gallery button (seen)
  done: 'Done',
  addLockWidgets: '(?i)add widgets', // lock-screen editor, drawn as ADD WIDGETS (seen)
};

const q = (s) => JSON.stringify(String(s));
const regexEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const header = (appId) => 'appId: ' + appId + '\n---\n';
const wait = (ms) => `- extendedWaitUntil:\n    visible: "qa-never-shown-1f4e"\n    timeout: ${ms}\n    optional: true\n`;

/** The app's first run when it has no .maestro/widgets/setup.yaml: launch, give it 20 s to write its widget data, leave. */
export function setupFlow(appId, platform) {
  return header(appId) + '- launchApp\n- waitForAnimationToEnd\n' + wait(20000) + (platform === 'ios' ? '- pressKey: home\n' : '');
}

/** Jiggle mode: hold the first dock icon (a zero-length swipe; longPressOn is ignored there), then "Edit Home Screen". */
const jiggle = () =>
  `- pressKey: home\n- waitForAnimationToEnd\n- swipe:\n    start: "39%,92%"\n    end: "39%,92%"\n    duration: 2500\n` +
  `- runFlow:\n    when:\n      visible: ${q(LABELS.editHome)}\n    commands:\n      - tapOn: ${q(LABELS.editHome)}\n- waitForAnimationToEnd\n`;

/**
 * Gallery pages of the app, in order: each kind of `plan.ios` (app.json order), each of its families (small, medium,
 * large). Returns [{ name, family, label, index }].
 */
export function galleryPages(plan) {
  const out = [];
  for (const k of plan.ios || []) for (const f of k.families) out.push({ name: k.name, family: f, label: k.label, index: out.length });
  return out;
}

/** Adds every home-screen widget of the plan from SpringBoard's gallery: Edit > Add Widget > the app > page N > Add Widget. */
export function iosAddFlow(plan) {
  let y = header('com.apple.springboard') + jiggle();
  for (const p of galleryPages(plan)) {
    y += `# ${p.name} ${p.family}\n- tapOn: ${q(LABELS.edit)}\n- tapOn: ${q(LABELS.addWidget)}\n- waitForAnimationToEnd\n`;
    y += `- scrollUntilVisible:\n    element:\n      text: ${q(regexEscape(plan.appName))}\n    direction: DOWN\n- tapOn: ${q(regexEscape(plan.appName))}\n- waitForAnimationToEnd\n`;
    for (let i = 0; i < p.index; i++) y += '- swipe:\n    direction: LEFT\n- waitForAnimationToEnd\n';
    y += `- takeScreenshot: gallery-${p.name}-${p.family}\n- tapOn: ${q(LABELS.addWidget)}\n- waitForAnimationToEnd\n`;
  }
  return y + `- tapOn: ${q(LABELS.done)}\n- waitForAnimationToEnd\n`;
}

/** Photographs home-screen pages 1..pages (swiping left; the caller drops repeats of the last page). */
export function iosShootFlow(prefix, pages) {
  let y = header('com.apple.springboard') + '- pressKey: home\n- waitForAnimationToEnd\n- pressKey: home\n- waitForAnimationToEnd\n';
  for (let i = 1; i <= pages; i++) y += `- takeScreenshot: ${prefix}-${i}\n` + (i < pages ? '- swipe:\n    direction: LEFT\n- waitForAnimationToEnd\n' : '');
  return y;
}

/** Edit > Customize > `option` (Tinted, Default, ...), then photographs `pages` pages as ios-tinted-N. */
export function iosTintFlow(option, pages) {
  let y = header('com.apple.springboard') + jiggle() + `- tapOn: ${q(LABELS.edit)}\n- tapOn: ${q(LABELS.customize)}\n- waitForAnimationToEnd\n`;
  y += `- tapOn: ${q(option)}\n- waitForAnimationToEnd\n- tapOn:\n    point: "50%,12%"\n- waitForAnimationToEnd\n`;
  y += `- tapOn:\n    text: ${q(LABELS.done)}\n    optional: true\n- waitForAnimationToEnd\n`;
  return pages ? y + iosShootFlow('ios-tinted', pages).split('---\n')[1] : y;
}

/** Lock screen (best effort): lock, long-press, Customize > Lock Screen > Add Widgets > the app > each widget, photographed. */
export function iosLockFlow(plan) {
  let y = header('com.apple.springboard') + '- pressKey: lock\n- waitForAnimationToEnd\n- pressKey: home\n- waitForAnimationToEnd\n- takeScreenshot: ios-lock-before\n';
  y += '- longPressOn:\n    point: "50%,45%"\n- waitForAnimationToEnd\n- takeScreenshot: ios-lock-gallery\n';
  y += `- tapOn: ${q(LABELS.customize)}\n- waitForAnimationToEnd\n- tapOn:\n    text: "Lock Screen"\n    optional: true\n- waitForAnimationToEnd\n- takeScreenshot: ios-lock-edit\n`;
  y += `- tapOn: ${q(LABELS.addLockWidgets)}\n- waitForAnimationToEnd\n`;
  y += `- scrollUntilVisible:\n    element:\n      text: ${q(regexEscape(plan.appName))}\n    direction: DOWN\n- tapOn: ${q(regexEscape(plan.appName))}\n- waitForAnimationToEnd\n- takeScreenshot: ios-lock-picker\n`;
  return y;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** junit with one test case per step (name last: summarize() reads the last name= of the tag): failure, skipped (a best-effort step that could not be done) or passed. */
export function junitXml(suite, cases) {
  const body = cases.map((c) => `  <testcase classname="${esc(suite)}" name="${esc(c.name)}">` +
    (c.ok ? '' : c.skipped ? `<skipped message="${esc(c.msg)}">${esc(c.msg)}</skipped>` : `<failure message="${esc(c.msg)}">${esc(c.msg)}</failure>`) + '</testcase>').join('\n');
  const failures = cases.filter((c) => !c.ok && !c.skipped).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n<testsuite name="${esc(suite)}" tests="${cases.length}" failures="${failures}">\n${body}\n</testsuite>\n</testsuites>\n`;
}
