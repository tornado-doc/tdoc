const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const source = fs.readFileSync(path.join(__dirname, '..', 'shell/src/document/model.js'), 'utf8');
const start = source.indexOf('export function layoutPins(');
const body = source.slice(start).replace(/export /g, '');
const box = {};
vm.createContext(box);
vm.runInContext(`${body}\nthis.layoutPins = layoutPins;`, box);
const { layoutPins } = box;
const pin = (id, docY, extra = {}) => ({ id, docY, ...extra });

console.log('React pin layout');

t('pins within 12px cluster', () => {
  const result = layoutPins([pin('a', 100), pin('b', 108)], 1000);
  assert(result.length === 1 && result[0].items.length === 2, 'same-line comments did not cluster');
});

t('separate pins maintain a 32px minimum gap', () => {
  const result = layoutPins([pin('a', 100), pin('b', 118)], 1000);
  assert(result.length === 2, 'distinct pins clustered');
  assert(result[1].y - result[0].y >= 32, 'minimum gap regressed');
});

t('comments on a tall element spread down the element', () => {
  const shared = { elementKey: '#chart', elementTop: 200, elementHeight: 300 };
  const result = layoutPins([
    pin('a', 200, shared), pin('b', 200, shared), pin('c', 200, shared),
  ], 1000);
  assert(result.length === 3, `expected 3 pins, got ${result.length}`);
});

t('comments on a short element remain clustered', () => {
  const shared = { elementKey: '#small', elementTop: 200, elementHeight: 20 };
  const result = layoutPins([pin('a', 200, shared), pin('b', 200, shared)], 1000);
  assert(result.length === 1 && result[0].items.length === 2, 'short element should cluster');
});

t('overflow folds into the last visible cluster without dropping comments', () => {
  const result = layoutPins(Array.from({ length: 10 }, (_, index) => pin(`c${index}`, index * 40)), 100);
  assert(result.every((cluster) => cluster.y <= 100), 'pin exceeded document height');
  assert(result.reduce((sum, cluster) => sum + cluster.items.length, 0) === 10, 'comments were dropped');
});

t('empty input yields no clusters', () => {
  assert(layoutPins([], 100).length === 0, 'empty input is not empty');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
