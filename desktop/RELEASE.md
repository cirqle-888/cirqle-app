# Desktop releases

## Public installer (what the team uses)

1. Set the version in `package.json` and in `latest.json` — its `download` is
   `https://github.com/cirqle-888/cirqle-app/releases/download/desktop-v<version>/Cirqle-Desktop-<version>-mac-arm64.dmg`.
2. Push to `main`. Installed apps read `latest.json` from GitHub and show the
   update badge; `https://app.cirqle.work/download` reads the same file.
3. Push the tag: `git tag desktop-v<version> && git push origin desktop-v<version>`.
   GitHub builds the installer (`.github/workflows/desktop-mac.yml`: the checks,
   then `npm run dmg`) and attaches it to that tag's release — the public
   download. The job stops if the tag and `package.json` disagree.

Do steps 2 and 3 together: between them the download address does not exist
yet. Nothing is uploaded by hand — the installer is about 120 MB.

`npm run dmg` also works locally, for trying a build before releasing it. The
app is signed locally ("ad-hoc"), not with an Apple Developer ID, so a first
launch needs **System Settings → Privacy & Security → Open Anyway**.

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
