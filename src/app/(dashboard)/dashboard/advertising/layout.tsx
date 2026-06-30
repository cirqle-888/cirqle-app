import { AdBackBar } from './_components/ad-back-bar'

export default function AdvertisingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AdBackBar />
      {children}
    </>
  )
}
