const fs = require('fs');
const path = require('path');

const examplesDir = path.join(__dirname, '..', 'examples');
const files = fs.readdirSync(examplesDir).filter(f => f.endsWith('.txs'));
let failed = [];

for (const f of files) {
  const p = path.join(examplesDir, f);
  const txt = fs.readFileSync(p, 'utf8');
  const regex = /^\s*(TYPEDEF)\s+([A-Za-z0-9_]+)/gm;
  let m;
  while ((m = regex.exec(txt)) !== null) {
    const kind = m[1];
    const name = m[2];
    const matchStart = m.index;
    const tokenIndexInMatch = m[0].search(/\S/);
    const start = matchStart + (tokenIndexInMatch >= 0 ? tokenIndexInMatch : 0);
    const endMarker = 'ENDDEF';
    const endIdx = txt.indexOf(endMarker, start);
    const sliceEnd = endIdx !== -1 ? endIdx + endMarker.length : Math.min(txt.length, start + 1000);
    const block = txt.slice(start, sliceEnd);
    if (/^\s/.test(block)) {
      const preview = block.slice(0, 40).replace(/\n/g, '\\n').replace(/\t/g, '\\t');
      failed.push({ file: f, name, preview });
    }
  }
}

if (failed.length) {
  console.error('Hover block start test FAILED. Found typedefs whose extracted hover block starts with whitespace:');
  for (const e of failed) {
    console.error(` - ${e.file}: ${e.name} -> preview: "${e.preview}"`);
  }
  process.exit(1);
} else {
  console.log('OK: all typedef hover blocks start without leading whitespace.');
  process.exit(0);
}
