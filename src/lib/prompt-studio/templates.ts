/**
 * Prompt Studio — the built-in template library.
 *
 * Each template is a "prompt that writes a prompt". The user writes what they
 * want in plain words; the template adds the client card and tight rules; any
 * AI turns that into a short, ready-to-use prompt for the video, image, voice
 * or music tool.
 *
 * House rules every template follows (they are what keep outputs short and
 * tokens low):
 *   - One job per template, one answer per run.
 *   - A hard word limit on the produced prompt.
 *   - "Output only … No explanation." so the AI never chats back.
 *   - Optional fields sit on their own line, so an empty one costs nothing.
 *
 * Keys are stable ids: saved library rows point at them, so never rename one.
 * Add new templates at the end of their category.
 */
import type { PromptCategory, PromptField, PromptTemplate } from './types'

export const CATEGORIES: PromptCategory[] = [
  { id: 'ad',      name: 'Ad Video',            description: 'Offer and promotion reels, step by step' },
  { id: 'film',    name: 'Film & Series',       description: 'Stories, episodes, characters and scenes' },
  { id: 'product', name: 'Product Videography', description: 'Packshots, hero clips, UGC and food' },
  { id: 'agency',  name: 'Agency Services',     description: 'Real estate, events, festivals, explainers and more' },
  { id: 'fix',     name: 'Fix & Reuse',         description: 'Repair, shorten, convert and review' },
]

// ── Shared fields ────────────────────────────────────────────────────────────
const NEED: PromptField = {
  key: 'need', label: 'What you need (your own words)', type: 'textarea', required: true,
  placeholder: 'Write it like you would tell a friend. English or Malayalam is fine.',
  help: 'Who is in it, where, what happens, the feeling, and what to avoid.',
}
const REFS: PromptField = {
  key: 'refs', label: 'Reference images you will attach', type: 'text',
  placeholder: 'bride, groom, wedding hall',
}
const SHOTS: PromptField = {
  key: 'shots', label: 'Shot list (paste from the shot list template)', type: 'textarea',
  placeholder: 'Paste the table here',
}
const RATIO: PromptField = {
  key: 'ratio', label: 'Size', type: 'select', options: ['9:16 vertical', '16:9 wide', '1:1 square', '4:5 portrait'],
}
const SECONDS: PromptField = {
  key: 'seconds', label: 'Total length (seconds)', type: 'number', placeholder: '45',
}
const VIDEO_TOOL: PromptField = {
  key: 'tool', label: 'Video tool', type: 'select',
  options: ['Veo 3.1 (Flow)', 'Kling', 'Seedance', 'Sora', 'Runway', 'Any'],
}

const AVOID_LINE = 'Then one line starting "Avoid:" with 5 short things to avoid.'

// ── Ad Video ─────────────────────────────────────────────────────────────────
const AD: PromptTemplate[] = [
  {
    key: 'ad-concepts', name: 'Ad concepts', category: 'ad',
    purpose: 'Three different ad ideas to choose from before you plan shots',
    useIn: 'Read it, pick one, then use Shot list', usesClientCard: true,
    fields: [NEED],
    body: `You are a creative director for short social video ads. Use the CLIENT CARD above.

MY NEED: {{need}}

Task: give 3 different ad concepts.
For each: a name (3 words), the hook in the first 2 seconds, the story in one sentence, the feeling, and why it will make people call.
Make them clearly different (for example emotional, funny, premium).
Output only the 3 concepts as a numbered list. No explanation.`,
  },
  {
    key: 'ad-shot-list', name: 'Shot list', category: 'ad',
    purpose: 'Turn your idea into a shot-by-shot plan every other template follows',
    useIn: 'Read it, then use for character, place, clip, voice and text templates', usesClientCard: true,
    fields: [NEED, SECONDS, { key: 'maxShots', label: 'Maximum shots', type: 'number', placeholder: '9' }],
    body: `You are a creative director for short video ads. Use the CLIENT CARD above.

MY NEED: {{need}}
Total length: {{seconds}} seconds
Maximum shots: {{maxShots}}

Task: plan one video ad.
Rules:
- Each shot is 4 to 8 seconds.
- The first 2 seconds must grab attention. The last shot shows the offer, phone numbers and a call to action.
- Show every item in "Must show". Never show anything in "Never show".
- Same characters and same place in every shot. Believable and local to the Client Card location.

Output only:
1. A table: Shot, Seconds, What we see, What is said, On-screen text (max 5 words).
2. One line listing the characters and places that need reference images.
No explanation.`,
  },
  {
    key: 'ad-character', name: 'Character image', category: 'ad',
    purpose: 'One reusable reference image of a person, so the face never changes',
    useIn: 'Flow, Nano Banana, ChatGPT images', usesClientCard: true,
    fields: [NEED, { key: 'style', label: 'Style', type: 'select', options: ['Photorealistic', 'Semi-realistic animated', '3D animated (Pixar-like)', 'Illustrated'] }],
    body: `You write prompts for AI image tools. Use the CLIENT CARD above.

MY NEED: {{need}}
Style: {{style}}

Task: write ONE prompt for a reusable character reference image.
Rules:
- Describe age, build, face shape, skin tone, hair or beard, eyes, expression, and the exact outfit with colors, fabric and jewelry.
- Natural for the Client Card location and community. Real skin texture, not plastic.
- Full body, facing the camera, soft even light, plain light background, face clearly visible.
- Maximum 90 words. No real people or celebrities.

Output only the prompt. ${AVOID_LINE} No explanation.`,
    tip: 'Make a second image of the same person from the side. Use the best one as the reference in every clip.',
  },
  {
    key: 'ad-place-image', name: 'Venue or place image', category: 'ad',
    purpose: 'A reference image of the hall, stage, shop or location',
    useIn: 'Flow, Nano Banana, ChatGPT images', usesClientCard: true,
    fields: [NEED, { key: 'framing', label: 'Framing', type: 'select', options: ['Wide shot', 'Medium shot', 'Close-up detail'] }],
    body: `You write prompts for AI image tools. Use the CLIENT CARD above.

MY NEED: {{need}}
Framing: {{framing}}

Task: write ONE prompt for a reference image of a place.
Rules:
- Say what it is, main colors, materials, flowers or props, and the mood.
- Say the time of day and the light, the camera height and direction.
- A real place in the Client Card location, not a fantasy set.
- No people, text, logos or signboards unless I ask.
- Maximum 80 words. Photorealistic.

Output only the prompt. ${AVOID_LINE} No explanation.`,
    tip: 'Use the client’s own photos as references whenever you have them. Real beats generated.',
  },
  {
    key: 'ad-video-clip', name: 'Video clip', category: 'ad',
    purpose: 'One shot at a time, ready for Veo, Kling or Seedance',
    useIn: 'Flow (Veo), Kling, Seedance', usesClientCard: true,
    fields: [NEED, REFS, VIDEO_TOOL, RATIO,
      { key: 'speech', label: 'Speech in this shot (optional)', type: 'text', placeholder: 'Leave empty for no speech' }],
    body: `You write prompts for AI video tools. Use the CLIENT CARD above.

MY NEED (one shot only): {{need}}
Reference images I will attach: {{refs}}
Tool: {{tool}}
Size: {{ratio}}
Speech: "{{speech}}"

Task: write ONE video prompt for a single shot.
Rules:
- One shot, one main action, 8 seconds or less.
- Order: shot type and camera move, who (same words as the references), action, place, light, mood, sound.
- One simple camera move only (slow push-in, slow orbit, handheld follow or static).
- If there is no speech, write "no speech, no on-screen text".
- Keep faces and clothes the same as the references. Natural, unhurried movement.
- Maximum 110 words.

Output only the prompt. ${AVOID_LINE} No explanation.`,
    tip: 'Generate each shot once. If it fails, use "Fix a bad result" instead of retrying the same words.',
  },
  {
    key: 'ad-voiceover-script', name: 'Voiceover script', category: 'ad',
    purpose: 'A spoken script that fits your shots and sounds natural',
    useIn: 'AI Studio speech, ElevenLabs, HeyGen', usesClientCard: true,
    fields: [NEED, SHOTS],
    body: `You are an advertising copywriter who writes for voiceover. Use the CLIENT CARD above.

MY NEED: {{need}}
MY SHOT LIST:
{{shots}}

Task: write the voiceover in the Client Card language.
Rules:
- One line per shot, speakable in that shot's seconds (about 2 to 2.5 words per second).
- Warm, everyday spoken language of the Client Card location. Not bookish or translated-sounding.
- Write common English words the way people say them, in the script of the language.
- Write all numbers and prices in full words so the voice reads them correctly.
- Use "..." for a small pause. No angle brackets or tags.
- Line 1 is a hook. The last line has the offer and "call today".
- No claims I did not give you.

Output only the lines, each with estimated seconds in brackets, then one line with total words and seconds. No explanation.`,
    tip: 'Ask a native speaker to read it once before generating the voice.',
  },
  {
    key: 'ad-voice-style', name: 'Voice style', category: 'ad',
    purpose: 'How the voice should sound, pasted above your script',
    useIn: 'AI Studio speech, ElevenLabs', usesClientCard: true,
    fields: [NEED, { key: 'gender', label: 'Voice', type: 'select', options: ['Female', 'Male', 'Child', 'Elderly female', 'Elderly male'] }],
    body: `You write style directions for text-to-speech tools. Use the CLIENT CARD above.

MY NEED: {{need}}
Voice: {{gender}}

Task: write ONE style direction to paste above a script.
Rules:
- Who is speaking, pace, feeling, and a natural accent for the Client Card location.
- A short pause at each "...", a longer pause before the offer and before the call line.
- Light stress on the price and the brand name.
- No angle brackets or tags. Maximum 60 words. Start with "Read aloud in".

Output only the style direction. No explanation.`,
  },
  {
    key: 'ad-music', name: 'Background music', category: 'ad',
    purpose: 'Instrumental music that stays under the voice',
    useIn: 'Lyria, Mureka, ElevenLabs Music', usesClientCard: true,
    fields: [NEED, SECONDS, { key: 'moments', label: 'Key moments', type: 'text', placeholder: 'price reveal at 39s, end card at 44s' }],
    body: `You write prompts for AI music tools. Use the CLIENT CARD above.

MY NEED: {{need}}
Length: {{seconds}} seconds
Key moments: {{moments}}

Task: write ONE music prompt.
Rules:
- Instrumental only. No vocals, no lyrics.
- Genre, mood, tempo in BPM, and 3 to 4 instruments that suit the audience and occasion.
- Shape: soft intro, gentle build, a lift at the key moments, clean ending with a 3-second fade.
- Keep the middle calm and light so a voice sits on top.
- Original. Do not copy any known song or film score.
- Maximum 70 words.

Output only the prompt. No explanation.`,
    tip: 'Mix the music about 12 dB below the voice.',
  },
  {
    key: 'ad-onscreen-text', name: 'On-screen text and end card', category: 'ad',
    purpose: 'Short headings, tick items, price reveal and end card',
    useIn: 'Your editing step', usesClientCard: true,
    fields: [NEED, SHOTS],
    body: `You write on-screen text for short video ads. Use the CLIENT CARD above.

MY NEED: {{need}}
MY SHOT LIST:
{{shots}}

Task: write all on-screen text.
Rules:
- Client Card language. Headings 4 words or fewer.
- Per shot: one heading and up to 3 tick items of 3 words or fewer.
- A hero title for shot 1. A price reveal with the exact price.
- End card: brand, offer line, location, "Connect Now", every phone number, a small terms line.
- Do not invent offers, numbers or claims.

Output only a table (Shot, Heading, Items), then the end card as separate lines. No explanation.`,
    tip: 'Check every phone number digit by digit.',
  },
]

// ── Film & Series ────────────────────────────────────────────────────────────
const GENRE: PromptField = {
  key: 'genre', label: 'Genre', type: 'select',
  options: ['Family drama', 'Comedy', 'Romance', 'Thriller', 'Mystery', 'Kids', 'Inspirational', 'Horror', 'Historical', 'Sci-fi'],
}
const EPISODE_LEN: PromptField = { key: 'epLength', label: 'Episode length (minutes)', type: 'number', placeholder: '3' }
const BIBLE: PromptField = {
  key: 'bible', label: 'Series plan (paste from Series plan template)', type: 'textarea',
  placeholder: 'Paste characters and world here',
}

const FILM: PromptTemplate[] = [
  {
    key: 'film-story-idea', name: 'Story idea', category: 'film',
    purpose: 'A one-line story, a short summary and the ending, from a rough idea',
    useIn: 'Read it, then use Series plan or Episode outline', usesClientCard: false,
    fields: [NEED, GENRE, { key: 'audience', label: 'Audience', type: 'text', placeholder: 'Kerala families on YouTube' }],
    body: `You are a story editor for short films and web series.

MY IDEA: {{need}}
Genre: {{genre}}
Audience: {{audience}}

Task: shape this into a clear story.
Output only:
1. Title options (3).
2. Logline (one sentence: who wants what, and what stops them).
3. Story in 5 sentences: setup, problem, turning point, darkest moment, ending.
4. Main characters (name, age, one-line want and flaw).
No explanation.`,
  },
  {
    key: 'film-series-bible', name: 'Series plan', category: 'film',
    purpose: 'Characters, world, look and episode list for a whole series',
    useIn: 'Keep it; paste into episode, character and scene templates', usesClientCard: false,
    fields: [NEED, GENRE, { key: 'episodes', label: 'Number of episodes', type: 'number', placeholder: '8' }, EPISODE_LEN],
    body: `You are a showrunner planning an AI-made web series.

MY SERIES: {{need}}
Genre: {{genre}}
Episodes: {{episodes}} of about {{epLength}} minutes

Task: write a compact series plan.
Output only:
1. Characters: name, age, look (face, hair, usual outfit with colors), personality, voice. 4 to 6 lines each, written so an image tool can redraw them the same way every time.
2. World: main locations with look, light and time period.
3. Visual style: one paragraph used in every prompt (camera, color, realism level).
4. Episode list: number, title, one-sentence plot, cliffhanger.
Keep it under 600 words. No explanation.`,
    tip: 'Save this once. Every later prompt reuses its character lines word for word, which keeps faces consistent.',
  },
  {
    key: 'film-episode-outline', name: 'Episode outline', category: 'film',
    purpose: 'Scene-by-scene beats for one episode',
    useIn: 'Read it, then use Scene script', usesClientCard: false,
    fields: [NEED, BIBLE, EPISODE_LEN],
    body: `You are a TV writer.

EPISODE: {{need}}
SERIES PLAN:
{{bible}}
Length: {{epLength}} minutes

Task: outline this episode.
Rules: open with a hook, end with a cliffhanger or payoff. Each scene moves the story.
Output only a table: Scene, Location, Characters, What happens (one sentence), Seconds. Total must match the length. No explanation.`,
  },
  {
    key: 'film-scene-script', name: 'Scene script', category: 'film',
    purpose: 'Dialogue and action for one scene, sized for AI clips',
    useIn: 'Read it, then use Scene to shots', usesClientCard: false,
    fields: [NEED, BIBLE, { key: 'language', label: 'Dialogue language', type: 'select', options: ['Malayalam', 'English', 'Manglish', 'Hindi', 'Tamil', 'Arabic'] }],
    body: `You are a screenwriter for short AI-made films.

SCENE: {{need}}
SERIES PLAN:
{{bible}}
Dialogue language: {{language}}

Task: write this scene.
Rules:
- Short lines. No line longer than 8 seconds when spoken.
- Simple actions an AI video tool can show (no fast fights, crowds or tiny hand details).
- Natural spoken language, not bookish.
Output only the script in standard format: scene heading, action lines, character names with dialogue. No explanation.`,
  },
  {
    key: 'film-scene-to-shots', name: 'Scene to shots', category: 'film',
    purpose: 'Break a scene into 8-second clips with camera and continuity',
    useIn: 'Read it, then run Video clip for each shot', usesClientCard: false,
    fields: [{ ...NEED, label: 'Paste the scene script', placeholder: 'Paste the scene here' }, VIDEO_TOOL, RATIO],
    body: `You are a director planning AI video shots.

SCENE SCRIPT:
{{need}}
Tool: {{tool}}
Size: {{ratio}}

Task: break the scene into shots of 8 seconds or less.
Rules: one action per shot; vary wide, medium and close-up; keep screen direction consistent; each line of dialogue fits inside one shot.
Output only a table: Shot, Seconds, Shot type and camera, Characters, Action, Dialogue, Continuity note (clothes, props, time of day). No explanation.`,
  },
  {
    key: 'film-character-sheet', name: 'Character sheet', category: 'film',
    purpose: 'A turnaround image of one character for consistent faces across episodes',
    useIn: 'Flow Characters, Nano Banana, ChatGPT images', usesClientCard: false,
    fields: [NEED, { key: 'style', label: 'Style', type: 'select', options: ['Photorealistic', 'Semi-realistic animated', '3D animated (Pixar-like)', 'Anime', 'Illustrated'] }],
    body: `You write prompts for AI image tools.

CHARACTER: {{need}}
Style: {{style}}

Task: write ONE prompt for a character reference sheet.
Rules:
- Same person shown front, three-quarter and side, full body, plus one close-up of the face, on a plain light background.
- Exact face, hair, skin tone, build, outfit with colors and accessories.
- Even studio light. No text or labels.
- Maximum 100 words.

Output only the prompt. ${AVOID_LINE} No explanation.`,
  },
  {
    key: 'film-location', name: 'Location set', category: 'film',
    purpose: 'A reusable reference image of a story location',
    useIn: 'Flow, Nano Banana, ChatGPT images', usesClientCard: false,
    fields: [NEED, { key: 'time', label: 'Time of day', type: 'select', options: ['Morning', 'Noon', 'Golden hour', 'Night', 'Rainy day'] }],
    body: `You write prompts for AI image tools.

LOCATION: {{need}}
Time of day: {{time}}

Task: write ONE prompt for an empty establishing image of this location, to reuse in many shots.
Rules: architecture, materials, props, colors, light, weather and era; wide eye-level view; no people, no text. Maximum 90 words.

Output only the prompt. ${AVOID_LINE} No explanation.`,
  },
  {
    key: 'film-dialogue-clip', name: 'Talking scene clip', category: 'film',
    purpose: 'A video prompt where a character speaks with lip sync',
    useIn: 'Veo 3.1, Kling, Seedance', usesClientCard: false,
    fields: [NEED, REFS, { key: 'line', label: 'Exact line spoken', type: 'textarea', required: true }, VIDEO_TOOL],
    body: `You write prompts for AI video tools that generate speech.

SHOT: {{need}}
Reference images I will attach: {{refs}}
Line spoken: "{{line}}"
Tool: {{tool}}

Task: write ONE prompt for a talking shot.
Rules:
- Medium close-up, face clearly visible, mouth not covered.
- Say who speaks, to whom, the emotion and how they say it.
- Put the line in quotes exactly as given. Only one speaker talks.
- Quiet background sound only. No music, no subtitles.
- 8 seconds or less. Maximum 100 words.

Output only the prompt. ${AVOID_LINE} No explanation.`,
    tip: 'If the language comes out wrong, generate the shot silent and add the voice in editing.',
  },
  {
    key: 'film-continuity-check', name: 'Continuity check', category: 'film',
    purpose: 'Catch changes in faces, clothes and props between shots',
    useIn: 'Any AI that can see images (attach frames)', usesClientCard: false,
    fields: [{ ...NEED, label: 'What to check', placeholder: 'I will attach one frame from each shot of scene 3' }, BIBLE],
    body: `You are a script supervisor checking continuity in AI-made video.

TASK: {{need}}
SERIES PLAN:
{{bible}}

Compare the attached frames with each other and with the plan.
Output only a table: Shot, Problem (face, hair, outfit, prop, light, background), How bad (low, medium, high), Fix (one short line). If nothing is wrong, say "No issues". No explanation.`,
  },
  {
    key: 'film-trailer', name: 'Trailer or teaser', category: 'film',
    purpose: 'A 30 to 60 second trailer plan with lines and text cards',
    useIn: 'Read it, then run Video clip for each shot', usesClientCard: false,
    fields: [NEED, BIBLE, SECONDS],
    body: `You are a trailer editor.

SERIES OR FILM: {{need}}
SERIES PLAN:
{{bible}}
Length: {{seconds}} seconds

Task: plan a trailer that makes people subscribe.
Rules: hook in 3 seconds, rising tension, no ending spoilers, title card near the end, release line last.
Output only a table: Shot, Seconds, Visual, Line or sound, Text card. No explanation.`,
  },
  {
    key: 'film-poster', name: 'Poster or thumbnail', category: 'film',
    purpose: 'A YouTube thumbnail or film poster image',
    useIn: 'Nano Banana, ChatGPT images, Flow', usesClientCard: false,
    fields: [NEED, { key: 'format', label: 'Format', type: 'select', options: ['YouTube thumbnail 16:9', 'Poster 2:3', 'Instagram 4:5', 'Story 9:16'] }],
    body: `You write prompts for AI image tools.

POSTER: {{need}}
Format: {{format}}

Task: write ONE prompt for a striking poster image.
Rules: one clear focal character or moment, strong emotion on the face, high contrast, space left for a title (but no text in the image), readable at small size. Maximum 80 words.

Output only the prompt. ${AVOID_LINE} No explanation.`,
    tip: 'Add the title yourself in Figma or Canva. AI text inside images is often misspelled.',
  },
  {
    key: 'film-score', name: 'Score or theme music', category: 'film',
    purpose: 'Mood music for a scene or a series theme',
    useIn: 'Lyria, Mureka, ElevenLabs Music', usesClientCard: false,
    fields: [NEED, SECONDS, { key: 'vocals', label: 'Vocals', type: 'select', options: ['Instrumental only', 'Humming only', 'With lyrics'] }],
    body: `You write prompts for AI music tools.

MUSIC FOR: {{need}}
Length: {{seconds}} seconds
Vocals: {{vocals}}

Task: write ONE music prompt.
Rules: genre, mood, tempo in BPM, 3 to 4 instruments, and how it changes over time. Original, not copying any known song or score. Maximum 70 words.

Output only the prompt. No explanation.`,
  },
]

// ── Product Videography ──────────────────────────────────────────────────────
const PRODUCT: PromptField = {
  key: 'product', label: 'Product (name, size, colors, material)', type: 'textarea', required: true,
  placeholder: '500 ml steel water bottle, matte black, gold logo',
}

const PRODUCT_T: PromptTemplate[] = [
  {
    key: 'product-shot-list', name: 'Product shot list', category: 'product',
    purpose: 'Plan a product video: hero, details, use and offer',
    useIn: 'Read it, then use the product image and clip templates', usesClientCard: true,
    fields: [NEED, PRODUCT, SECONDS, RATIO],
    body: `You are a product video director. Use the CLIENT CARD above.

MY NEED: {{need}}
PRODUCT: {{product}}
Length: {{seconds}} seconds
Size: {{ratio}}

Task: plan a product video.
Rules: hook in 2 seconds; show the product big and clear; one benefit per shot; a real-life use moment; end with price or offer and call to action.
Output only a table: Shot, Seconds, Visual, Camera move, Text (max 5 words). No explanation.`,
  },
  {
    key: 'product-packshot', name: 'Packshot image', category: 'product',
    purpose: 'A clean studio image of the product for ads and listings',
    useIn: 'Nano Banana, ChatGPT images, Flow', usesClientCard: true,
    fields: [PRODUCT, NEED, { key: 'bg', label: 'Background', type: 'select', options: ['Pure white', 'Soft gradient in brand color', 'Natural surface (wood, marble, stone)', 'Lifestyle blur'] }],
    body: `You write prompts for AI product photography. Use the CLIENT CARD above.

PRODUCT: {{product}}
MY NEED: {{need}}
Background: {{bg}}

Task: write ONE packshot prompt.
Rules: product centered and sharp; true colors and label shape kept exactly; soft studio light with a gentle reflection or shadow; 3/4 angle unless I say otherwise; no extra objects, hands or text. Maximum 70 words.

Output only the prompt. ${AVOID_LINE} No explanation.`,
    tip: 'Attach a real photo of the product as the reference so the label stays correct.',
  },
  {
    key: 'product-hero-clip', name: 'Hero product clip', category: 'product',
    purpose: 'A premium slow-motion or turntable shot of the product',
    useIn: 'Veo, Kling, Seedance', usesClientCard: true,
    fields: [PRODUCT, NEED, { key: 'move', label: 'Camera move', type: 'select', options: ['Slow 360 turntable', 'Slow push-in', 'Macro slide across details', 'Top-down reveal', 'Splash or pour in slow motion'] }, RATIO],
    body: `You write prompts for AI video tools. Use the CLIENT CARD above.

PRODUCT: {{product}}
MY NEED: {{need}}
Camera move: {{move}}
Size: {{ratio}}

Task: write ONE hero shot prompt.
Rules: the product stays the same shape and label the whole time; premium studio or brand-color light; one camera move; 6 to 8 seconds; no hands, no text, no extra products. Maximum 90 words.

Output only the prompt. ${AVOID_LINE} No explanation.`,
  },
  {
    key: 'product-lifestyle', name: 'Lifestyle scene', category: 'product',
    purpose: 'The product being used by a real-looking person in a real place',
    useIn: 'Veo, Kling, Seedance', usesClientCard: true,
    fields: [PRODUCT, NEED, REFS, RATIO],
    body: `You write prompts for AI video tools. Use the CLIENT CARD above.

PRODUCT: {{product}}
SCENE: {{need}}
Reference images I will attach: {{refs}}
Size: {{ratio}}

Task: write ONE lifestyle shot prompt.
Rules: a believable local person and place from the Client Card; the product clearly visible and used correctly; natural light; one action; 8 seconds or less; no text or other brands. Maximum 100 words.

Output only the prompt. ${AVOID_LINE} No explanation.`,
  },
  {
    key: 'product-ugc-script', name: 'UGC review script', category: 'product',
    purpose: 'A creator-style talking review script with shot notes',
    useIn: 'HeyGen, Arcads, or film a real person', usesClientCard: true,
    fields: [PRODUCT, NEED, SECONDS],
    body: `You write UGC (creator-style) ad scripts. Use the CLIENT CARD above.

PRODUCT: {{product}}
MY NEED: {{need}}
Length: {{seconds}} seconds

Task: write a natural, phone-filmed style review.
Rules: first line is a hook in the creator's own voice; one problem, the product as the fix, two real benefits, a soft call to action; everyday spoken language from the Client Card; no claims I did not give.
Output only a table: Seconds, Line spoken, What we see. No explanation.`,
  },
  {
    key: 'product-unboxing', name: 'Unboxing video', category: 'product',
    purpose: 'Satisfying unboxing shots, hands only',
    useIn: 'Veo, Kling, Seedance', usesClientCard: true,
    fields: [PRODUCT, NEED, RATIO],
    body: `You write prompts for AI video tools. Use the CLIENT CARD above.

PRODUCT AND BOX: {{product}}
MY NEED: {{need}}
Size: {{ratio}}

Task: write 3 short shot prompts for an unboxing: opening the box, lifting the product out, a close look at the product.
Rules: top-down or 45-degree view; clean hands with natural nails; soft daylight on a neutral table; slow, satisfying movement; label and shape stay exact; each 6 seconds or less; maximum 70 words each.

Output only the 3 prompts, numbered. ${AVOID_LINE} No explanation.`,
  },
  {
    key: 'product-before-after', name: 'Before and after', category: 'product',
    purpose: 'Show the problem, then the result with the product',
    useIn: 'Veo, Kling, Seedance', usesClientCard: true,
    fields: [PRODUCT, NEED, RATIO],
    body: `You write prompts for AI video tools. Use the CLIENT CARD above.

PRODUCT: {{product}}
BEFORE AND AFTER: {{need}}
Size: {{ratio}}

Task: write 2 matching shot prompts: BEFORE and AFTER.
Rules: same camera angle, place and light in both so the change is obvious; honest, believable result (no magic); 5 seconds each; maximum 70 words each.

Output only the 2 prompts labeled BEFORE and AFTER. ${AVOID_LINE} No explanation.`,
  },
  {
    key: 'product-food', name: 'Food video', category: 'product',
    purpose: 'Mouth-watering restaurant or bakery shots',
    useIn: 'Veo, Kling, Seedance', usesClientCard: true,
    fields: [{ ...PRODUCT, label: 'Dish (name, ingredients, plate)', placeholder: 'Malabar chicken biryani on a copper plate' }, NEED,
      { key: 'action', label: 'Action', type: 'select', options: ['Steam rising, slow push-in', 'Pour or drizzle', 'Spoon lifting a portion', 'Top-down table spread', 'Cooking on fire'] }, RATIO],
    body: `You write prompts for AI food videos. Use the CLIENT CARD above.

DISH: {{product}}
MY NEED: {{need}}
Action: {{action}}
Size: {{ratio}}

Task: write ONE food shot prompt.
Rules: real texture, glossy but natural; warm side light; shallow depth of field; authentic local serving style; one action; 6 to 8 seconds; no people's faces, no text. Maximum 80 words.

Output only the prompt. ${AVOID_LINE} No explanation.`,
  },
  {
    key: 'product-fashion', name: 'Model wearing product', category: 'product',
    purpose: 'Jewellery, sarees, abayas, watches or clothing on a model',
    useIn: 'Nano Banana, Flow, Kling, Seedance', usesClientCard: true,
    fields: [PRODUCT, NEED, REFS, { key: 'output', label: 'Output', type: 'select', options: ['Image', 'Video clip'] }, RATIO],
    body: `You write prompts for AI fashion and jewellery content. Use the CLIENT CARD above.

PRODUCT: {{product}}
MY NEED: {{need}}
Reference images I will attach: {{refs}}
Output: {{output}}
Size: {{ratio}}

Task: write ONE prompt.
Rules: the product is the hero and keeps its exact design, metal or fabric, and color; a model natural to the Client Card audience; elegant pose; soft beauty light; close enough to see detail; for video one slow move under 8 seconds. Maximum 90 words.

Output only the prompt. ${AVOID_LINE} No explanation.`,
  },
]

// ── Agency Services ──────────────────────────────────────────────────────────
const AGENCY: PromptTemplate[] = [
  {
    key: 'agency-offer-reel', name: 'Offer or sale reel', category: 'agency',
    purpose: 'Supermarket, shop or restaurant offer reel from a price list',
    useIn: 'Read it, then use clip and text templates', usesClientCard: true,
    fields: [NEED, { key: 'items', label: 'Offer items and prices', type: 'textarea', required: true, placeholder: 'Paste the price list' }, { key: 'dates', label: 'Offer dates', type: 'text' }, SECONDS],
    body: `You are a retail ad creative director. Use the CLIENT CARD above.

MY NEED: {{need}}
OFFER ITEMS:
{{items}}
Dates: {{dates}}
Length: {{seconds}} seconds

Task: plan a fast, energetic offer reel.
Rules: pick the 5 to 8 strongest deals; one deal per beat of 2 to 3 seconds; big price text; shop name and dates at the end; prices exactly as given.
Output only a table: Beat, Seconds, Product shot, Text on screen, Voice line (short). No explanation.`,
  },
  {
    key: 'agency-festival-greeting', name: 'Festival greeting', category: 'agency',
    purpose: 'Onam, Eid, Vishu, Christmas, Diwali or New Year greeting video',
    useIn: 'Veo, Kling, Seedance', usesClientCard: true,
    fields: [{ key: 'festival', label: 'Festival', type: 'select', required: true, options: ['Onam', 'Vishu', 'Eid al-Fitr', 'Eid al-Adha', 'Ramadan', 'Christmas', 'Diwali', 'New Year', 'Independence Day', 'Republic Day'] }, NEED, RATIO],
    body: `You write prompts for AI video tools. Use the CLIENT CARD above.

FESTIVAL: {{festival}}
MY NEED: {{need}}
Size: {{ratio}}

Task: write ONE 8-second greeting shot prompt.
Rules: authentic, respectful festival details for the Client Card location; warm, joyful mood; brand colors where natural; leave the lower third clean for a greeting text and logo; no text in the video. Maximum 90 words.
Then write the greeting line in the Client Card language (max 8 words).

Output only the prompt, the "Avoid:" line, and the greeting line. No explanation.`,
  },
  {
    key: 'agency-real-estate', name: 'Property walkthrough', category: 'agency',
    purpose: 'Villa, flat or plot tour plan with shot prompts',
    useIn: 'Real footage plan or Veo, Kling', usesClientCard: true,
    fields: [NEED, { key: 'property', label: 'Property details', type: 'textarea', required: true, placeholder: '3BHK villa, 2200 sq ft, pool, Kozhikode' }, SECONDS, RATIO],
    body: `You are a real estate video director. Use the CLIENT CARD above.

MY NEED: {{need}}
PROPERTY: {{property}}
Length: {{seconds}} seconds
Size: {{ratio}}

Task: plan a walkthrough that sells the lifestyle.
Rules: start with the best exterior or view; move room to room in a logical path; smooth gimbal-style moves; golden-hour or bright daylight; end with price, location and call to action. Only features I listed.
Output only a table: Shot, Seconds, Room or area, Camera move, Text (max 5 words). No explanation.`,
  },
  {
    key: 'agency-event-highlight', name: 'Event highlight edit', category: 'agency',
    purpose: 'Edit plan for a wedding or event from real footage',
    useIn: 'Your editor (Premiere, CapCut, DaVinci)', usesClientCard: true,
    fields: [NEED, { key: 'footage', label: 'Footage you have', type: 'textarea', placeholder: 'Bride entry, stage, family, food, dance, 2 hours raw' }, SECONDS, { key: 'song', label: 'Music feel', type: 'text' }],
    body: `You are a wedding and event film editor. Use the CLIENT CARD above.

MY NEED: {{need}}
FOOTAGE I HAVE: {{footage}}
Length: {{seconds}} seconds
Music feel: {{song}}

Task: plan the highlight edit.
Rules: emotional open, build, peak moment, calm close; cut on the beat; mix wide, detail and reaction shots; family and emotion over decoration.
Output only a table: Part, Seconds, Clips to use, Transition, Music cue. No explanation.`,
  },
  {
    key: 'agency-explainer', name: 'Explainer video', category: 'agency',
    purpose: 'Explain a service, app or process simply in 60 to 90 seconds',
    useIn: 'Read it, then voice, text and motion templates', usesClientCard: true,
    fields: [NEED, SECONDS, { key: 'style', label: 'Style', type: 'select', options: ['Motion graphics', 'Real footage', 'AI video', 'Presenter on camera'] }],
    body: `You are an explainer video writer. Use the CLIENT CARD above.

WHAT TO EXPLAIN: {{need}}
Length: {{seconds}} seconds
Style: {{style}}

Task: write the explainer.
Rules: problem, solution, how it works in 3 steps, one proof point, call to action; simple words a local customer understands; Client Card language.
Output only a table: Seconds, Voice line, Visual. No explanation.`,
  },
  {
    key: 'agency-brand-film', name: 'Brand story film', category: 'agency',
    purpose: 'Founder story or about-us film that builds trust',
    useIn: 'Read it, then shot and voice templates', usesClientCard: true,
    fields: [NEED, { key: 'facts', label: 'Real facts (year started, people, milestones)', type: 'textarea' }, SECONDS],
    body: `You are a brand film writer. Use the CLIENT CARD above.

MY NEED: {{need}}
REAL FACTS: {{facts}}
Length: {{seconds}} seconds

Task: write a brand story film.
Rules: open on a human moment; show where they started, what they care about, who they serve; use only the facts given; end on a promise and the brand name.
Output only a table: Seconds, Voice line, Visual (real footage or AI). No explanation.`,
  },
  {
    key: 'agency-reel-calendar', name: '30-day reel plan', category: 'agency',
    purpose: 'A month of reel ideas for a client',
    useIn: 'Social calendar', usesClientCard: true,
    fields: [NEED, { key: 'count', label: 'Number of reels', type: 'number', placeholder: '12' }, { key: 'month', label: 'Month', type: 'text', placeholder: 'November 2026' }],
    body: `You are a social media strategist. Use the CLIENT CARD above.

MY NEED: {{need}}
Reels: {{count}}
Month: {{month}}

Task: plan the month's reels.
Rules: mix offers, behind the scenes, customer stories, tips and trends; include local festivals and dates in that month; each reel 15 to 30 seconds and doable with AI or a phone.
Output only a table: Date, Reel idea, Hook (first line), Format (AI, phone, motion), Call to action. No explanation.`,
  },
  {
    key: 'agency-logo-reveal', name: 'Logo reveal', category: 'agency',
    purpose: 'A short animated logo intro or outro',
    useIn: 'Veo, Kling (image to video), After Effects brief', usesClientCard: true,
    fields: [NEED, { key: 'logo', label: 'Logo description', type: 'text', required: true, placeholder: 'Red star with wave, word SEASTAR in gold' }, { key: 'effect', label: 'Effect', type: 'select', options: ['Light sweep', 'Particles forming', 'Gold foil shine', 'Ink or smoke', '3D rotate', 'Minimal fade'] }],
    body: `You write prompts for logo animations. Use the CLIENT CARD above.

LOGO: {{logo}}
MY NEED: {{need}}
Effect: {{effect}}

Task: write ONE prompt for a 4-second logo reveal, starting from the attached logo image.
Rules: the logo's shape, letters and colors must not change; brand-color background; the logo ends sharp and still in the center for the last second. Maximum 70 words.

Output only the prompt. ${AVOID_LINE} No explanation.`,
    tip: 'AI tools often bend letters. If it does, animate only the background and lay the real logo file on top.',
  },
  {
    key: 'agency-avatar-presenter', name: 'Presenter or avatar script', category: 'agency',
    purpose: 'A talking-head script for a presenter, owner or AI avatar',
    useIn: 'HeyGen, Arcads, or a real person', usesClientCard: true,
    fields: [NEED, SECONDS, { key: 'who', label: 'Who speaks', type: 'text', placeholder: 'Owner, friendly, mid-40s' }],
    body: `You write presenter scripts. Use the CLIENT CARD above.

MY NEED: {{need}}
Length: {{seconds}} seconds
Speaker: {{who}}

Task: write a direct-to-camera script.
Rules: speak to one person ("you"); hook first; short sentences; Client Card language; mark [pause] where needed; end with one clear action.
Output only the script, then one line with total words. No explanation.`,
  },
  {
    key: 'agency-testimonial-questions', name: 'Testimonial interview', category: 'agency',
    purpose: 'Questions that get real, usable customer testimonials',
    useIn: 'Shoot day with a customer', usesClientCard: true,
    fields: [NEED],
    body: `You are a documentary interviewer. Use the CLIENT CARD above.

MY NEED: {{need}}

Task: write interview questions for a customer testimonial.
Rules: 8 open questions (no yes/no); start easy, then the problem before, the experience, the result, and who they would recommend it to; one follow-up for each; tell them to answer in full sentences.
Output only the numbered questions with follow-ups. No explanation.`,
  },
  {
    key: 'agency-caption-hashtags', name: 'Caption and hashtags', category: 'agency',
    purpose: 'Post caption, hashtags and first comment for a finished video',
    useIn: 'Instagram, Facebook, YouTube Shorts', usesClientCard: true,
    fields: [NEED, { key: 'platform', label: 'Platform', type: 'select', options: ['Instagram Reel', 'Facebook', 'YouTube Shorts', 'WhatsApp Status'] }],
    body: `You write social media captions. Use the CLIENT CARD above.

THE VIDEO: {{need}}
Platform: {{platform}}

Task: write the post.
Rules: first line is a hook under 10 words; 2 to 4 short lines; offer and phone number; Client Card language with an English line if useful; 8 to 12 hashtags mixing local and niche.
Output only the caption, then the hashtags. No explanation.`,
  },
  {
    key: 'agency-subtitles', name: 'Subtitles and translation', category: 'agency',
    purpose: 'Timed subtitles or a translation of a script',
    useIn: 'CapCut, Premiere, YouTube (SRT)', usesClientCard: false,
    fields: [{ ...NEED, label: 'Paste the script or transcript' }, { key: 'to', label: 'Translate to', type: 'select', options: ['Same language', 'English', 'Malayalam', 'Arabic', 'Hindi', 'Tamil'] }],
    body: `You are a subtitle editor.

SCRIPT:
{{need}}
Language: {{to}}

Task: make subtitles.
Rules: max 2 lines of 32 characters each; break at natural pauses; keep names, prices and phone numbers exact; natural, not word-for-word.
Output only SRT format with estimated times. No explanation.`,
  },
]

// ── Fix & Reuse ──────────────────────────────────────────────────────────────
const FIX: PromptTemplate[] = [
  {
    key: 'fix-bad-result', name: 'Fix a bad result', category: 'fix',
    purpose: 'Change only what went wrong, so you do not waste credits',
    useIn: 'The same tool that gave the bad result', usesClientCard: false,
    fields: [
      { key: 'tool', label: 'Tool', type: 'text', placeholder: 'Veo 3.1 in Flow' },
      { key: 'old', label: 'Old prompt', type: 'textarea', required: true },
      { key: 'wrong', label: 'What went wrong (your words)', type: 'textarea', required: true },
      { key: 'want', label: 'What you want instead', type: 'textarea' },
    ],
    body: `You fix prompts for AI image, video, voice and music tools.

TOOL: {{tool}}
OLD PROMPT:
{{old}}
WHAT WENT WRONG: {{wrong}}
WHAT I WANT INSTEAD: {{want}}

Task: write ONE improved prompt.
Rules:
- Keep everything that was good. Change only what fixes the problem.
- Remove or reword the words that likely caused it.
- Say what I want in positive words first, then one short "Avoid:" line.
- If words cannot fix it, say so in one sentence and give the simplest workaround.
- Same length or shorter than the old prompt.

Output only the new prompt, then one line starting "Why:" with the single change. No explanation.`,
    tip: 'Common causes: too many actions in one shot, two camera moves, text inside the video, an unclear reference face.',
  },
  {
    key: 'fix-cutdowns', name: 'Short cuts and other sizes', category: 'fix',
    purpose: '15-second cut, square or story version from a finished ad',
    useIn: 'Your editor', usesClientCard: true,
    fields: [SHOTS, { key: 'script', label: 'Voiceover lines', type: 'textarea' }, NEED],
    body: `You are a video editor planning cut-downs. Use the CLIENT CARD above.

MY SHOT LIST:
{{shots}}
VOICEOVER:
{{script}}
MY NEED: {{need}}

Task: plan the shorter or resized versions using only what I already have.
Rules: hook first; offer, price, phone and call to action last; voice within 2 to 2.5 words per second; for a new size say how to crop each shot and where text sits in the safe area; no new clips.
Output only one table per version: Order, Shot, Trim from-to, Voice line, Text. Then the final length. No explanation.`,
  },
  {
    key: 'fix-shorten-prompt', name: 'Shorten a prompt', category: 'fix',
    purpose: 'Cut a long prompt down without losing what matters',
    useIn: 'Any AI tool', usesClientCard: false,
    fields: [{ key: 'old', label: 'Long prompt', type: 'textarea', required: true }, { key: 'words', label: 'Target words', type: 'number', placeholder: '60' }],
    body: `You compress prompts for AI tools.

PROMPT:
{{old}}
Target: {{words}} words or fewer

Task: rewrite it shorter.
Rules: keep subject, action, place, light, camera, style and must-avoid items; drop repeats, filler and adjectives that change nothing.
Output only the shorter prompt. No explanation.`,
  },
  {
    key: 'fix-convert-tool', name: 'Convert for another tool', category: 'fix',
    purpose: 'Rewrite a prompt in the style another AI tool understands best',
    useIn: 'The new tool', usesClientCard: false,
    fields: [{ key: 'old', label: 'Prompt', type: 'textarea', required: true },
      { key: 'from', label: 'From tool', type: 'text', placeholder: 'Veo 3.1' },
      { key: 'to', label: 'To tool', type: 'select', required: true, options: ['Veo 3.1', 'Kling', 'Seedance', 'Sora', 'Runway', 'Nano Banana', 'ChatGPT images', 'Midjourney', 'ElevenLabs', 'Lyria', 'Mureka'] }],
    body: `You are an expert in AI generation tools.

PROMPT (written for {{from}}):
{{old}}
NEW TOOL: {{to}}

Task: rewrite the prompt for the new tool.
Rules: keep the same content; use the structure, length and wording that tool follows best; remove features it does not support and say which in one line.
Output only the new prompt, then the one line about removed features. No explanation.`,
  },
  {
    key: 'fix-review-video', name: 'Review before sending', category: 'fix',
    purpose: 'A quick quality check of a finished video before the client sees it',
    useIn: 'Any AI that can watch video or see frames', usesClientCard: true,
    fields: [{ ...NEED, label: 'What to review', placeholder: 'I will attach the final video' }],
    body: `You are a strict ad reviewer. Use the CLIENT CARD above.

TO REVIEW: {{need}}

Check the attached video against the Client Card.
Check: hook in 2 seconds; every "Must show" item; nothing from "Never show"; spelling of every word; price and phone numbers exact; faces and clothes consistent; text readable on a phone; voice and text in sync; ending with a clear call to action.
Output only a table: Check, OK or Problem, Time in video, Fix. No explanation.`,
  },
  {
    key: 'fix-brief-to-card', name: 'Client message to Client Card', category: 'fix',
    purpose: 'Turn a messy WhatsApp brief into a clean Client Card',
    useIn: 'Paste the answer into the Client Card', usesClientCard: false,
    fields: [{ ...NEED, label: 'Paste the client’s message', placeholder: 'Paste the WhatsApp or voice-note text' }],
    body: `You organise client briefs.

CLIENT MESSAGE:
{{need}}

Task: fill a Client Card from this message.
Fields: Brand, Business, Location, Offer, Phone / address, Audience, Language, Look and feel, Brand colors, Must show, Never show, Length and size.
Rules: use only what the message says; write "ASK CLIENT" for anything missing.
Output only the fields, one per line as "Field: value". No explanation.`,
  },
]

export const TEMPLATES: PromptTemplate[] = [...AD, ...FILM, ...PRODUCT_T, ...AGENCY, ...FIX]

export function templateByKey(key: string): PromptTemplate | undefined {
  return TEMPLATES.find(t => t.key === key)
}
