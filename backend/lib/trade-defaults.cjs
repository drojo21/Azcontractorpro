// CommonJS wrapper around trade_defaults.json.
//
// `import x from './trade_defaults.json' with { type: 'json' }` needs Node
// >= 20.10 and a recent esbuild; on an older build image the function fails to
// bundle and silently never deploys, which looks exactly like a 404 on every
// route. require() of JSON works everywhere and bundles cleanly.
module.exports = require('./trade_defaults.json');
