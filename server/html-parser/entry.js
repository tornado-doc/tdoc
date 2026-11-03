// The HTML parser the worker uses to check AI suggestions (Ask/Edit v2):
// parse5, the WHATWG parsing algorithm browsers implement, so the server reads
// a stored doc the way the reader's browser will. Vendored as one file
// (parse5.js, built from this entry by `npm run build:parser`) because the
// worker is assembled by bin/tdoc-bundle without a bundler.
export { parse } from 'parse5';
