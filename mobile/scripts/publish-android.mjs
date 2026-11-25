// Publish a built Android app so every installed app offers it as an update.
//
// The phone app is installed by hand (no Play Store), so a new native build
// used to mean sending the APK to each person. This puts the signed APK at a
// public address and records it in public/mobile/latest.json; once that file is
// deployed, an installed app with a lower build number shows "Update available"
// (src/components/mobile/update-banner.tsx) and the Download button opens the
// APK in the phone's browser.
//
// The APK must sit on a DIFFERENT host from the app itself: the app's WebView
// keeps links to its own host inside the WebView, where a download does nothing.
// It goes to a public Supabase Storage bucket for that reason.
//
// Run from the repo root, after mobile/scripts/build-android.sh:
//
//   node --env-file=.env.local mobile/scripts/publish-android.mjs [--apk <path>] [--notes "what changed"]
//
// Then commit public/mobile/latest.json and deploy. Nothing is offered to
// anyone until that deploy.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const BUCKET = 'app-releases'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}
function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

const { versionName, versionCode } = JSON.parse(await readFile(resolve(root, 'mobile/app-version.json'), 'utf8'))
if (!versionName || !Number.isInteger(versionCode)) fail('mobile/app-version.json needs versionName and an integer versionCode.')

const apkPath = resolve(arg('apk') ?? resolve(root, `mobile/dist/Cirqle-${versionName}-release-signed.apk`))
const size = await stat(apkPath).then(s => s.size, () => 0)
if (!size) fail(`No signed APK at ${apkPath}. Build it first: bash mobile/scripts/build-android.sh`)
// A name without the version in it is probably the wrong file — an older build
// published under a newer number would be offered to everyone and never install.
if (!apkPath.includes(versionName)) fail(`${apkPath} does not look like version ${versionName}.`)

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) fail('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set — run with --env-file=.env.local.')
const supabase = createClient(url, key, { auth: { persistSession: false } })

const { data: buckets, error: listError } = await supabase.storage.listBuckets()
if (listError) fail(`Could not read storage buckets: ${listError.message}`)
if (!buckets.some(b => b.name === BUCKET)) {
  const { error } = await supabase.storage.createBucket(BUCKET, { public: true })
  if (error) fail(`Could not create the ${BUCKET} bucket: ${error.message}`)
  console.log(`▶ Created public bucket "${BUCKET}".`)
}

// The build number is in the name so a phone's browser never serves an older
// download from its cache under the same address.
const objectPath = `android/Cirqle-${versionName}-${versionCode}.apk`
console.log(`▶ Uploading ${(size / 1024 / 1024).toFixed(1)} MB as ${BUCKET}/${objectPath}…`)
const { error: uploadError } = await supabase.storage.from(BUCKET).upload(objectPath, await readFile(apkPath), {
  contentType: 'application/vnd.android.package-archive',
  upsert: true,
})
if (uploadError) fail(`Upload failed: ${uploadError.message}`)

const publicUrl = supabase.storage.from(BUCKET).getPublicUrl(objectPath).data.publicUrl
const head = await fetch(publicUrl, { method: 'HEAD' })
if (!head.ok) fail(`Uploaded, but ${publicUrl} answers ${head.status}.`)

const manifest = { versionCode, versionName, url: publicUrl, ...(arg('notes') ? { notes: arg('notes') } : {}) }
const manifestPath = resolve(root, 'public/mobile/latest.json')
await mkdir(dirname(manifestPath), { recursive: true })
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`✓ Published ${versionName} (build ${versionCode}).`)
console.log(`  APK:      ${publicUrl}`)
console.log('  Manifest: public/mobile/latest.json — commit and deploy it to offer the update.')
