# WhatsApp capture: share a message into the Requests inbox

Written 10 Nov 2026. Status: built and tested locally; **not yet deployed, and not yet tried with a real voice note.**

## What it does

In WhatsApp, long-press a message, voice note or photo, tap **Share**, and pick **Send to Cirqle**.
Within a few seconds a new item appears in **Requests**, marked new, with:

- a title, client, service and due date suggested by AI (staff correct them);
- the message text, or the voice note written out, or the writing read from a photo;
- a link to the original voice note or photo, kept in private storage;
- a first line saying it came from WhatsApp, and the group and sender if given.

Admins also get a notification. It works with groups, direct chats, and any WhatsApp number.

It only files a request. It never creates a task, never replies to the client, never posts anywhere.

## Why sharing, and not automatic

Most requests arrive in WhatsApp **groups**. WhatsApp has no official way to read existing group chats
automatically (checked Nov 2026: the official API's group feature needs a special account status and only
covers new, small groups it creates itself). Unofficial "linked device" tools can read groups but break
WhatsApp's terms and can get the number banned. One tap per message is the safe route.

## Limits

| Limit | Value |
|---|---|
| File size | 4 MB each (a voice note of several minutes fits) |
| Files per share | 5 |
| Works with | text, voice notes, audio, photos (JPG, PNG, WebP, HEIC) |
| Not read | video, PDF and other documents (reported back as skipped) |
| Photo reading | off until `GROQ_VISION_MODEL` is set; the photo is still attached |

Voice notes are written out by Groq's speech model. **Accuracy on Malayalam and mixed Malayalam-English
has not been tested.** Try 20 real voice notes before relying on it; the recording is always attached, and
a note that cannot be transcribed is filed as "listen and add details", never dropped.

Client content (the text, the audio, the photo) is sent to Groq for this, as the app's existing AI
features already do.

## One-time server setup

1. Deploy the app.
2. In Vercel → Project → Settings → Environment Variables, add **`WHATSAPP_CAPTURE_TOKEN`** with a long
   random value (`openssl rand -hex 32`), then redeploy. This token can only file a request here.
   - Do **not** give staff the existing `SHORTCUT_API_TOKEN`. It also works on this route, but on
     `/api/shortcut` it can record payments and expenses.
   - To stop a phone from sending, change the token and redeploy.
3. Optional: set `GROQ_VISION_MODEL` to the same vision model id Offer Studio uses, to read handwritten
   lists from photos.

## iPhone setup (about 5 minutes per phone)

In the **Shortcuts** app:

1. Tap **+** and name the shortcut **Send to Cirqle**.
2. Tap the **ⓘ** button, turn on **Show in Share Sheet**. Under **Share Sheet Types**, leave only
   **Text, Images, Media and Files** ticked.
3. Add the action **Get Contents of URL** and set:
   - URL: `https://app.cirqle.work/api/shortcut/whatsapp`
   - Method: **POST**
   - Headers: add `Authorization` with the value `Bearer ` followed by the capture token
   - Request Body: **Form**
   - Add a field named `file`, type **File**, value **Shortcut Input**
   - Optional: add a field named `client`, type **Text**, value **Ask Each Time**, to type the client
     name when sharing (leave it blank to let the AI guess)
   - Optional: add a field named `group`, type **Text**, with the group name if this phone mostly
     shares from one group
4. Add **Get Dictionary Value**, key `say`, from the result of step 3.
5. Add **Show Notification** with that value. It will read, for example:
   `Filed REQ-0071: Friday offer flyer. Client: Sea Star Supermarket`.

To use it: in WhatsApp, long-press the message → **Share** (or **Forward** → share icon) → **Send to Cirqle**.

Android phones need a different app to do the same (any app that can send a shared file as a form POST);
that has not been set up or tested.

## What the server answers

`POST /api/shortcut/whatsapp` (multipart form; fields `file`, `text`, `client`, `group`, `sender`).

```json
{ "ok": true, "ref": "REQ-0071", "title": "Friday offer flyer", "client": "Sea Star Supermarket",
  "matchedClient": true, "heard": "…first 200 characters of the transcript…",
  "needsListening": false, "skipped": [], "say": "Filed REQ-0071: …" }
```

On a problem: `{ "ok": false, "error": "…" }` with status 400 (nothing usable shared), 401 (wrong token)
or 503 (no token configured).

## Where the code is

| File | What |
|---|---|
| `src/app/api/shortcut/whatsapp/route.ts` | The entry point: token check, form reading, storage, notification |
| `src/lib/shortcut/whatsapp-capture.ts` | The logic, with tests beside it |
| `src/lib/ai/vision.ts` | Optional photo reading |
| `src/lib/ai/transcribe.ts` | Voice to text (already existed, used by chat) |
| `src/lib/shortcut/actions.ts` | `createRequest` gained "file as new" and links |

Originals are stored in the private `chat-attachments` bucket under `whatsapp-capture/<month>/`, and the
link on the request is valid for one year. Requests still use the source value `manual`: the database
only allows four source values, and adding `whatsapp` needs a hand-run migration that was left out on purpose.

## Not built yet

- Uploading a whole exported chat to pull out several requests at once.
- A "WhatsApp" filter in the Requests inbox.
- Automatic capture of direct chats through the official WhatsApp Business API.
