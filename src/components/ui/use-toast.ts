import * as React from "react"

export interface ToastProps {
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  variant?: "default" | "destructive"
}

export function useToast() {
  const [toasts, setToasts] = React.useState<ToastProps[]>([])

  const toast = React.useCallback((props: ToastProps) => {
    setToasts((prev) => [...prev, props])
    // In a real app this would trigger a context update or a global store
    console.log("Toast Triggered:", props)
  }, [])

  return { toast, toasts }
}
