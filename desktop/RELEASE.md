# Desktop releases

## Public installer (what the team uses)

1. Set the version in `package.json` and in `latest.json` (its `download` is the
   release address `publish-mac.sh` prints the pattern for).
2. `npm run dmg` — runs the checks and builds `dist/Cirqle Desktop-<version>-arm64.dmg`.
   The app is signed locally ("ad-hoc"), not with an Apple Developer ID, so a
   first launch needs **System Settings → Privacy & Security → Open Anyway**.
3. `bash scripts/publish-mac.sh` — uploads the installer as a public GitHub
   release. It refuses to run if `latest.json` does not describe this build.
4. Commit and push `latest.json`. Installed apps read it from GitHub and show
   the update badge; `https://app.cirqle.work/download` reads the same file and
   always offers the published build, with the first-launch steps.

More options → Install in Applications is available when the packaged app is
launched outside Applications; it will not overwrite an existing copy.

## Signed automatic updates

`npm run release:signed` checks the app, signs it with a Developer ID Application
certificate, notarizes it with Apple, and builds both DMG and ZIP artifacts.
The signed profile alone sets the runtime marker enabling electron-updater.
The default profile stays unsigned. The release command uses `--publish never`:
it prepares artifacts without publishing to GitHub.

Supply credentials through your environment or secret manager:

- `CIRQLE_SIGN_IDENTITY`: the Developer ID Application certificate identity.
- The certificate must be in the signing keychain, or configured through the
  usual `CSC_LINK` and `CSC_KEY_PASSWORD` environment variables.
- Apple notarization: either `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID`, or `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.

The preflight reports missing requirements without printing their values.
No certificate or account credentials are stored in this repository.

After reviewing the signed output, publish the matching version's ZIP, DMG,
blockmaps and `latest-mac.yml` to the `cirqle-888/cirqle-app` GitHub release.
For unsigned releases, separately update `desktop/latest.json` after uploading
the matching installer. This file is not advanced merely by making a local build.

The app offers to download a signed update, shows progress, and provides a
Restart to update button. Installation waits for the user's click and checks
for unsaved Flyer work. Downloads/verification failures leave the current app
in place. Signed update delivery has not been exercised without credentials
and a published signed release.

## Verification

`npm run check` runs channel, layout, recovery, share and update regression checks.
`npm run check:desktop` runs an actual Electron smoke test against local fixture
pages with isolated user data, mock dialogs and update/microphone prompts disabled.
It verifies startup, saved layout persistence, expand/restore and dirty-close
protection. No staff sessions or hosted application records are used.
