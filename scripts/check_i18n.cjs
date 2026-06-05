const fs = require('fs');
const js = fs.readFileSync('f:/qvactext/text2/frontend/renderer/app.js', 'utf8');
const idx = js.indexOf('// ---- DOM 引用 ----');
const after = js.substring(idx);
const lines = after.split('\n');
let count = 0;
lines.forEach((l, i) => {
  const t = l.trim();
  if (!t || t.startsWith('//')) return;
  const chinese = l.match(/[一-鿿]/g);
  if (chinese && !l.includes('I18N[') && !l.includes('t("') && !l.includes("t('") && !l.includes('tLang(')) {
    count += chinese.length;
    if (count <= 500) console.log((i + 1) + ': ' + t.substring(0, 120));
  }
});
console.log('Total remaining Chinese chars in code: ' + count);
