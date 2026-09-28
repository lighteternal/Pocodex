// Copy the pinned Phosphor assets without modifying their SVG paths.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../companion');
const source = path.join(root, 'node_modules/@phosphor-icons/core');
const target = path.join(root, 'ui/icons');
fs.mkdirSync(target, { recursive: true });
for (const name of ['speaker-high', 'speaker-slash', 'x', 'check', 'arrow-up-right', 'magnifying-glass', 'paw-print', 'book-open', 'chart-bar', 'gear-six']) {
  fs.copyFileSync(path.join(source, 'assets/regular', `${name}.svg`), path.join(target, `${name}.svg`));
}
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(target, 'LICENSE.txt'));
