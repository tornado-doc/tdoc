// Re-exports shared/github-oauth.js in the repo checkout.
// tdoc-publish overwrites this path with a flat copy of the SoT for deploy
// (~/.tdoc/vercel-app has no ../../shared/).
module.exports = require('../../shared/github-oauth.js');
