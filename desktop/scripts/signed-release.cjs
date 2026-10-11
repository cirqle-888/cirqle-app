'use strict'
const { spawnSync } = require('child_process')
const path = require('path')
const hasAppleAccount = ['APPLE_ID','APPLE_APP_SPECIFIC_PASSWORD','APPLE_TEAM_ID'].every(key => !!process.env[key])
const hasApiKey = ['APPLE_API_KEY','APPLE_API_KEY_ID','APPLE_API_ISSUER'].every(key => !!process.env[key])
if (!process.env.CIRQLE_SIGN_IDENTITY || (!hasAppleAccount && !hasApiKey)) {
  console.error('Signed release needs CIRQLE_SIGN_IDENTITY and Apple notarization credentials. See RELEASE.md. No credentials are printed or saved.')
  process.exit(1)
}
const result = spawnSync(process.execPath,[path.join(__dirname,'../node_modules/electron-builder/out/cli/cli.js'),'--config','electron-builder.signed.cjs','--mac','--publish','never',...process.argv.slice(2)],{cwd:path.join(__dirname,'..'),stdio:'inherit'})
if (result.error) { console.error(result.error.message); process.exit(1) }
process.exit(result.status ?? 1)
