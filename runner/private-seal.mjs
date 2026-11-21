// Seals out/<platform> into sealed/<platform>/<platform>.enc with PRIVATE_QA_KEY. Prints sizes only.
import { sealDir } from './private.mjs';

const dir = process.argv[2];
const platform = process.argv[3];
if (!/^(ios|android)$/.test(platform || '')) throw new Error('platform must be ios or android');
const n = sealDir(dir, process.env.PRIVATE_RID || '', platform, process.env.PRIVATE_QA_KEY || '');
console.log('[private] sealed ' + platform + ': ' + n + ' bytes');
