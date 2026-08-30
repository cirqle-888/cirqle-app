/**
 * Ambient declarations for globals the app sets on `window`.
 *
 * Declaring them here is what lets the call sites drop their `@ts-ignore`.
 * A `@ts-ignore` suppresses the whole line, so it hides any OTHER error on
 * that line too — including a genuine typo in the property name, which is
 * exactly the kind of mistake an untyped global invites.
 */

export {}

declare global {
  interface Window {
    /**
     * Hand-off slot for Quick Capture.
     *
     * The Requests screen reads the clipboard and stashes the text here before
     * routing to /dashboard/capture, because the capture screen may not have
     * mounted yet when the `cirqle:capture` event fires. Capture drains it on
     * mount and sets it back to null.
     */
    __pendingCirqleCapture?: { text?: string; phone?: string } | null
  }
}
