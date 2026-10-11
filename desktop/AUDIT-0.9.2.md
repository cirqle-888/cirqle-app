# Cirqle Desktop 0.9.2 audit

## Reported problem

Flyer Cirqle was visible as a pane without its own labelled close control.
The icon-only toggle and split menu were difficult to identify, particularly
with many WhatsApp accounts. Closing the only pane was also refused by the
layout engine.

## Changes

- Added a permanent pane strip below the toolbar with names and direct × controls.
- Both Flyer panes can close independently. Closing the last non-Cirqle pane
  returns to Cirqle. Closing a split keeps Flyer navigation and WhatsApp login.
- WhatsApp account tabs scroll, and secondary controls are reduced at narrow widths.
- Added sender/main-frame checks to desktop messages. Remote pages cannot invoke
  toolbar, account management, download opening, or window management operations.
- Replaced WhatsApp's privileged toolbar preload with error-page retry only.
- Restricted Cirqle/Flyer navigation to configured app origins, and WhatsApp
  navigation to its own origin. External links use allowed web/contact schemes.
- Replaced microphone permission URL-prefix matching with exact app origins.
- Sanitized downloaded filenames and constrained receipt MIME types and size.
- Restricted clipboard-history polling to the focused desktop window.
- Wait for the composer result before reporting an auto-paste attempt.
- Queue cold-start protocol links until the window exists.
- Added a timeout to update requests and filtered external update URLs.
- Removed HTML injection from the pane load-error message.
- Prevented duplicate pane replacement and normalized invalid pane widths.
- Capture/navigation can reveal Cirqle when all four pane slots are occupied.

## Verification

The build gates pass: all 49 channels are accounted for; pane placement, hiding,
limits and saved layouts pass. Added regression checks cover single-Flyer close,
sender isolation, subframe rejection, download path containment and queued links.
A browser UI smoke check confirms close controls are visible and dispatch the
correct pane at 900px and 1440px, including the lone second Flyer pane, with no
page errors. This UI check used a mocked desktop bridge rather than staff accounts.

## Remaining limits

Live WhatsApp login, attachment acceptance, receipt delivery, microphone recording,
and notifications need checking in an authenticated desktop session. Auto-paste
reports the operation, not delivery, and remains dependent on WhatsApp's DOM.
The app remains unsigned, has manual installation/update, and depends on the
hosted Cirqle/Flyer services. Signing requires the owner's Apple credentials.
No staff accounts or production records were changed during this audit.
