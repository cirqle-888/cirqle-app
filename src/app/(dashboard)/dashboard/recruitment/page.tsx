import { redirect } from 'next/navigation'

/** Bare /dashboard/recruitment lands on the Applications pipeline. */
export default function RecruitmentIndexPage() {
  redirect('/dashboard/recruitment/applications')
}
