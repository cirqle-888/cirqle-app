'use strict'
module.exports = {
  extends: './electron-builder.yml',
  forceCodeSigning: true,
  extraMetadata: { signedUpdates: true },
  mac: {
    identity: process.env.CIRQLE_SIGN_IDENTITY,
    hardenedRuntime: true,
    notarize: true,
    entitlements: 'assets/entitlements.mac.plist',
    entitlementsInherit: 'assets/entitlements.mac.plist',
    target: ['dmg', 'zip'],
  },
  publish: [{ provider: 'github', owner: 'cirqle-888', repo: 'cirqle-app' }],
}
