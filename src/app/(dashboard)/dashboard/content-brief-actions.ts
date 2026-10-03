'use server'

/**
 * Upload endpoint for the shared Content Brief block (Social Calendar +
 * Requests). Same public `social-refs` bucket the calendar has always used, so
 * existing reference images and new ones live side by side — but open to
 * anyone who can plan in EITHER place, not only social.manage.
 */

import { resolveImageExt, IMAGE_UPLOAD_ERROR, IMAGE_EXT_BY_TYPE, MAX_IMAGE_BYTES } from '@/lib/uploads'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAnyPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { todayISO } from '@/lib/utils/local-date'

export async function getBriefImageUploadUrl(
  filename: string,
  contentType?: string,
): Promise<{ ok: boolean; error?: string; data?: { uploadUrl: string; publicUrl: string } }> {
  const guard = await requireAnyPermission([PERMS.SOCIAL_MANAGE, PERMS.REQUESTS_MANAGE])
  if (!guard.ok) return { ok: false, error: guard.error }

  // Public bucket: an unchecked extension would let a .html upload be served
  // from our own origin.
  const ext = resolveImageExt(filename, contentType)
  if (!ext) return { ok: false, error: IMAGE_UPLOAD_ERROR }

  const admin = createAdminClient()
  try {
    await admin.storage.createBucket('social-refs', {
      public: true,
      fileSizeLimit: MAX_IMAGE_BYTES,
      allowedMimeTypes: Object.keys(IMAGE_EXT_BY_TYPE),
    })
  } catch { /* exists */ }
  const path = `${todayISO()}/${crypto.randomUUID()}.${ext}`
  const { data, error } = await admin.storage.from('social-refs').createSignedUploadUrl(path)
  if (error || !data) return { ok: false, error: 'Could not prepare the upload.' }
  const { data: pub } = admin.storage.from('social-refs').getPublicUrl(path)
  return { ok: true, data: { uploadUrl: data.signedUrl, publicUrl: pub.publicUrl } }
}
