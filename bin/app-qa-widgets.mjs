// app-qa --widgets: which home-screen and lock-screen widgets an Expo app declares (the `expo-widgets` config plugin in
// app.json), as the WIDGETS plan the runner's widget step (runner/app-widgets.mjs) works from. Pure; tested in
// test/app-qa-widgets.test.mjs.

const HOME = ['systemSmall', 'systemMedium', 'systemLarge', 'systemExtraLarge'];
const LOCK = ['accessoryCircular', 'accessoryRectangular', 'accessoryInline'];
export const WIDGETS_RE = /^(all|[A-Za-z0-9_]+(,[A-Za-z0-9_]+)*)$/;

/**
 * expo: app.json's `expo` object; only: 'all' or comma-separated widget names. Returns
 * { appName, android: [name], ios: [{ name, label, families }], lock: [{ name, label, families }] }:
 * iOS families in the gallery's order (small, medium, large, extra large; lock: circular, rectangular, inline).
 * Android widgets count only with `enableAndroid`. Throws when the app declares no widgets or `only` names an unknown one.
 */
export function widgetPlan(expo, only = 'all') {
  if (!WIDGETS_RE.test(only)) throw new Error('--widgets takes all or widget names, comma-separated');
  const entry = (expo.plugins || []).find((p) => (Array.isArray(p) ? p[0] : p) === 'expo-widgets');
  const conf = Array.isArray(entry) ? entry[1] || {} : {};
  const list = conf.widgets || [];
  if (!list.length) throw new Error('--widgets: app.json declares no widgets (expo-widgets plugin)');
  const wanted = only === 'all' ? null : only.split(',');
  for (const n of wanted || []) if (!list.some((w) => w.name === n)) throw new Error('--widgets: no widget named ' + n + ' in app.json');
  const plan = { appName: expo.name || '', android: [], ios: [], lock: [] };
  for (const w of list) {
    if (wanted && !wanted.includes(w.name)) continue;
    const label = w.displayName || w.name;
    if (conf.enableAndroid && w.android) plan.android.push(w.name);
    const fams = w.ios?.supportedFamilies || [];
    const home = HOME.filter((f) => fams.includes(f));
    const lock = LOCK.filter((f) => fams.includes(f));
    if (w.ios && home.length) plan.ios.push({ name: w.name, label, families: home });
    if (w.ios && lock.length) plan.lock.push({ name: w.name, label, families: lock });
  }
  return plan;
}

/** The platforms of `platforms` that have at least one widget in the plan. */
export const widgetPlatforms = (plan, platforms) => platforms.filter((p) => (p === 'android' ? plan.android.length : plan.ios.length + plan.lock.length) > 0);
