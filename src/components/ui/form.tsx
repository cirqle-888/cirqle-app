"use client"

import * as React from "react"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

const FormFieldContext = React.createContext<{
  id: string
  error?: string | boolean
} | null>(null)

const useFormField = () => {
  const context = React.useContext(FormFieldContext)
  if (!context) {
    throw new Error("useFormField should be used within <FormField>")
  }
  const { id, error } = context
  return {
    id,
    error,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
  }
}

interface FormFieldProps extends React.HTMLAttributes<HTMLDivElement> {
  error?: string | boolean
}

const FormField = React.forwardRef<HTMLDivElement, FormFieldProps>(
  ({ className, error, ...props }, ref) => {
    const id = React.useId()
    return (
      <FormFieldContext.Provider value={{ id, error }}>
        <div ref={ref} className={cn("space-y-1.5", className)} {...props} />
      </FormFieldContext.Provider>
    )
  }
)
FormField.displayName = "FormField"

const FormLabel = React.forwardRef<
  React.ElementRef<typeof Label>,
  React.ComponentPropsWithoutRef<typeof Label>
>(({ className, ...props }, ref) => {
  const { formItemId } = useFormField()
  return (
    <Label
      ref={ref}
      className={cn("text-muted-foreground", className)}
      htmlFor={formItemId}
      {...props}
    />
  )
})
FormLabel.displayName = "FormLabel"

// Stamps the field's id/aria attributes onto its single child control so the
// FormLabel htmlFor and FormMessage/FormDescription ids actually connect.
const FormControl = ({ children }: { children: React.ReactElement }) => {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField()
  return React.cloneElement(children, {
    id: formItemId,
    "aria-describedby": error
      ? `${formDescriptionId} ${formMessageId}`
      : formDescriptionId,
    "aria-invalid": !!error,
  } as React.HTMLAttributes<HTMLElement>)
}
FormControl.displayName = "FormControl"

const FormDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => {
  const { formDescriptionId } = useFormField()
  return (
    <p
      ref={ref}
      id={formDescriptionId}
      className={cn("text-[0.8rem] text-muted-foreground", className)}
      {...props}
    />
  )
})
FormDescription.displayName = "FormDescription"

const FormMessage = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, children, ...props }, ref) => {
  const { error, formMessageId } = useFormField()
  // A boolean error flags invalid state but carries no text of its own.
  const body = typeof error === "string" && error ? error : children

  if (!body) {
    return null
  }

  return (
    <p
      ref={ref}
      id={formMessageId}
      className={cn("text-[0.8rem] font-medium text-destructive", className)}
      {...props}
    >
      {body}
    </p>
  )
})
FormMessage.displayName = "FormMessage"

export {
  useFormField,
  FormField,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
}
