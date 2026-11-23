// Splits the junit.xml of one Maestro session (several flows) into one folder per flow, the layout the GitHub shards
// produce: <out>/ios-<pass>-<flow>/junit.xml (+ checks.txt). A flow is matched by the `name:` in its YAML header, or
// by its file name when it has none. Usage: app-split-junit.mjs <session dir> <pass> <out dir> <flow>...
import fs from 'node:fs';
import path from 'node:path';

const [session, pass, out, ...flows] = process.argv.slice(2);
const xml = fs.existsSync(path.join(session, 'junit.xml')) ? fs.readFileSync(path.join(session, 'junit.xml'), 'utf8') : '';
const cases = [...xml.matchAll(/<testcase[^>]*\bname="([^"]+)"[^>]*?(\/>|>[\s\S]*?<\/testcase>)/g)].map((m) => ({ name: m[1], xml: m[0] }));
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const flowsDir = process.env.APP_READY ? path.join(process.env.APP_READY, '.maestro') : '.maestro';
for (const flow of flows) {
  const yaml = fs.existsSync(path.join(flowsDir, flow + '.yaml')) ? fs.readFileSync(path.join(flowsDir, flow + '.yaml'), 'utf8') : '';
  const name = (/^name:\s*(.+)$/m.exec(yaml.split(/^---$/m)[0])?.[1] || flow).trim().replace(/^["']|["']$/g, '');
  const c = cases.find((x) => unescape(x.name) === name || x.name === flow);
  const dir = path.join(out, 'ios-' + pass + '-' + flow);
  fs.mkdirSync(dir, { recursive: true });
  if (c) fs.writeFileSync(path.join(dir, 'junit.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="' + flow + '">' + c.xml + '</testsuite></testsuites>\n');
  const checks = path.join(out, 'ios-checks.txt');
  if (fs.existsSync(checks)) fs.copyFileSync(checks, path.join(dir, 'checks.txt'));
}
