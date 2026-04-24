/**
 * One-off: extract RU object from i18n.js, dump all dot-paths → i18n-paths-ru.json
 * Run: node scripts/dump-ru-locale.cjs
 */
const fs = require('fs');
const path = require('path');
const s = fs.readFileSync(path.join(__dirname, '..', 'i18n.js'), 'utf8');
const start = s.indexOf('const RU = ');
if (start < 0) process.exit(1);
let i = start + 'const RU = '.length;
let depth = 0;
let st = -1;
let end;
for (; i < s.length; i++) {
    const c = s[i];
    if (c === '{') {
        if (depth === 0) st = i;
        depth++;
    } else if (c === '}') {
        depth--;
        if (depth === 0) {
            end = i + 1;
            break;
        }
    }
}
const RU = new Function('return ' + s.slice(st, end))();

function walk(obj, pfx, out) {
    for (const k of Object.keys(obj)) {
        const p = pfx ? `${pfx}.${k}` : k;
        const v = obj[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            walk(v, p, out);
        } else {
            out[p] = v;
        }
    }
}
const flat = {};
walk(RU, '', flat);
fs.writeFileSync(
    path.join(__dirname, '..', 'i18n-paths-ru.json'),
    JSON.stringify(flat, null, 2),
    'utf8'
);
console.log('wrote', Object.keys(flat).length, 'keys to i18n-paths-ru.json');
