# Notification sounds

The app's notification sounds are synthesized in the browser (see
`src/lib/notifications/chime.ts`) — no files needed for the built-in
Chime / Ding / Bell / Pop options.

To use your own sound, drop an MP3 here named exactly:

    notification.mp3

A **Custom** option then appears in the sound picker (bell dropdown →
Sound). Keep it short (≤ 2s) and quiet — it plays for every incoming
message and alert. If the file is missing or can't be decoded, the app
falls back to the default chime rather than going silent.
