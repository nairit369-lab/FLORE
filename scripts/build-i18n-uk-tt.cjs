/**
 * Build i18n-uk-tt.js + optional i18n-paths-uk.json / i18n-paths-tt.json from i18n-uk-tt-pairs.json
 * Run: node scripts/build-i18n-uk-tt.cjs
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ru = JSON.parse(fs.readFileSync(path.join(root, 'i18n-paths-ru.json'), 'utf8'));
const ruKeys = Object.keys(ru);
const pairs = JSON.parse(fs.readFileSync(path.join(root, 'i18n-uk-tt-pairs.json'), 'utf8'));

function unflatten(flat) {
    const o = {};
    for (const [k, v] of Object.entries(flat)) {
        if (typeof v !== 'string') continue;
        const parts = k.split('.');
        let x = o;
        for (let i = 0; i < parts.length - 1; i++) {
            const p = parts[i];
            if (!x[p] || typeof x[p] !== 'object') x[p] = {};
            x = x[p];
        }
        x[parts[parts.length - 1]] = v;
    }
    return o;
}

const ukFlat = {};
const ttFlat = {};
for (const k of ruKeys) {
    if (!pairs[k] || typeof pairs[k].uk !== 'string' || typeof pairs[k].tt !== 'string') {
        throw new Error(`i18n-uk-tt-pairs.json: missing or invalid key: ${k}`);
    }
    ukFlat[k] = pairs[k].uk;
    ttFlat[k] = pairs[k].tt;
}

const ukNested = unflatten(ukFlat);
const ttNested = unflatten(ttFlat);

const out = `(function () {
  'use strict';
  try {
    window.FLOR_I18N_UK = ${JSON.stringify(ukNested)};
    window.FLOR_I18N_TT = ${JSON.stringify(ttNested)};
  } catch (e) { console.error('i18n-uk-tt load', e); }
})();`;
fs.writeFileSync(path.join(root, 'i18n-uk-tt.js'), out, 'utf8');

const pretty = 2;
fs.writeFileSync(path.join(root, 'i18n-paths-uk.json'), JSON.stringify(ukFlat, null, pretty) + '\n', 'utf8');
fs.writeFileSync(path.join(root, 'i18n-paths-tt.json'), JSON.stringify(ttFlat, null, pretty) + '\n', 'utf8');

console.log('Wrote i18n-uk-tt.js, i18n-paths-uk.json, i18n-paths-tt.json (' + ruKeys.length + ' keys)');
