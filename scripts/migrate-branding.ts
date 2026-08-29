import { createAdminClient } from '../src/lib/supabase/admin'
import { loadEnvConfig } from '@next/env'
import crypto from 'crypto'

loadEnvConfig(process.cwd())

const isDryRun = process.argv.includes('--dry-run')

async function main() {
  if (isDryRun) {
    console.log('--- DRY RUN MODE: No modifications will be made ---\n')
  }

  const admin = createAdminClient()
  
  const { data, error } = await admin
    .from('company_settings')
    .select('key, value')
    
  if (error) {
    console.error('Failed to fetch settings:', error)
    process.exit(1)
  }
  
  const toMigrate = data.filter(row => row.value && typeof row.value === 'string' && row.value.startsWith('data:image'))
  
  if (toMigrate.length === 0) {
    console.log('No base64 branding assets found. Migration already completed or not needed.')
    return
  }
  
  console.log(`Found ${toMigrate.length} base64 assets to migrate.`)
  
  for (const row of toMigrate) {
    console.log(`\n--- Migrating ${row.key} ---`)
    
    const matches = row.value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
    if (!matches) {
      console.error(`Failed to parse data URI for ${row.key}.`)
      continue
    }
    
    const mimeType = matches[1]
    const buffer = Buffer.from(matches[2], 'base64')
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex')
    const shortHash = checksum.substring(0, 8)
    const size = buffer.length
    
    let ext = mimeType.split('/')[1].split('+')[0]
    if (ext === 'vnd.microsoft.icon') ext = 'ico'
    if (ext === 'jpeg') ext = 'jpg'
    
    const storagePath = `${row.key}/${shortHash}.${ext}`
    const expectedDbValue = `storage:company-branding/${storagePath}`
    
    console.log(`Size: ${size} bytes`)
    console.log(`MIME: ${mimeType}`)
    console.log(`SHA256: ${checksum}`)
    console.log(`Dest: company-branding/${storagePath}`)
    console.log(`Expected DB: ${expectedDbValue}`)
    
    if (isDryRun) {
      console.log(`[DRY RUN] Would verify idempotency, upload, verify, and update DB.`)
      continue
    }
    
    // 1. Idempotency Check
    const { data: existingList } = await admin.storage
      .from('company-branding')
      .list(row.key, { search: `${shortHash}.${ext}` })
      
    let existsAndValid = false
    
    if (existingList && existingList.length > 0) {
      const fileMeta = existingList.find(f => f.name === `${shortHash}.${ext}`)
      if (fileMeta) {
        console.log(`Found existing object. Size in storage: ${fileMeta.metadata?.size}`)
        if (fileMeta.metadata?.size === size) {
            console.log('Idempotency check passed: File already exists with correct size.')
            existsAndValid = true
        } else {
            console.log('Existing file size mismatch! Will re-upload.')
        }
      }
    }
    
    // 2. Upload
    if (!existsAndValid) {
        const { data: uploadData, error: uploadError } = await admin.storage
          .from('company-branding')
          .upload(storagePath, buffer, {
            contentType: mimeType,
            upsert: true
          })
          
        if (uploadError) {
          console.error(`Upload failed for ${row.key}:`, uploadError)
          console.log('Aborting migration for this key.')
          continue
        }
    }
    
    // 3. Strict Verification
    const { data: listData, error: listError } = await admin.storage
      .from('company-branding')
      .list(row.key, { search: `${shortHash}.${ext}` })
      
    if (listError || !listData || listData.length === 0) {
      console.error(`Verification failed: Object not found after upload for ${row.key}.`)
      continue
    }
    
    const uploadedMeta = listData.find(f => f.name === `${shortHash}.${ext}`)
    if (!uploadedMeta) {
      console.error(`Verification failed: Could not find exactly ${shortHash}.${ext}.`)
      continue
    }
    
    if (uploadedMeta.metadata?.size !== size) {
        console.error(`Verification failed: Size mismatch. Expected ${size}, got ${uploadedMeta.metadata?.size}.`)
        continue
    }
    
    if (uploadedMeta.metadata?.mimetype !== mimeType) {
        // Supabase sometimes canonicalizes mimetypes (e.g. image/vnd.microsoft.icon -> image/x-icon). Warn but don't strictly fail if base type is image
        if (!uploadedMeta.metadata?.mimetype.startsWith('image/')) {
            console.error(`Verification failed: Mime mismatch. Expected ${mimeType}, got ${uploadedMeta.metadata?.mimetype}.`)
            continue
        } else {
            console.log(`Note: Mimetype in storage is ${uploadedMeta.metadata?.mimetype} (original: ${mimeType})`)
        }
    }
    
    console.log(`Verification passed! Object exists with matching size.`)
    
    // 4. Update Database
    const { error: updateError } = await admin
      .from('company_settings')
      .update({ value: expectedDbValue })
      .eq('key', row.key)
      
    if (updateError) {
      console.error(`Failed to update company_settings for ${row.key}:`, updateError)
      console.log('Original base64 value remains in the database safely.')
      continue
    }
    
    console.log(`Successfully migrated ${row.key}!`)
  }
  
  console.log('\nMigration complete.')
}

main().catch(console.error)
