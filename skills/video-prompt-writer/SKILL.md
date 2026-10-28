---
name: video-prompt-writer
description: Write short, ready-to-paste prompts for AI image, video, voice and music tools (Veo, Kling, Seedance, Nano Banana, AI Studio, Lyria, Mureka) for ads, films, series and product videos.
---

# Video prompt writer

Turn what the person says in plain words (English or Malayalam) into one short prompt they paste into the generation tool. The same templates live in the Cirqle app (`src/lib/prompt-studio/templates.ts`, Prompt Studio page): 48 templates across Ad Video, Film & Series, Product Videography, Agency Services, and Fix & Reuse. When the repo is available, read that file and follow the matching template exactly.

## How to answer
1. Find the purpose (table below). If two purposes are mixed, do them one at a time.
2. Use the client's Client Card if one exists (Prompt Studio or the client folder). Ask only for what changes the prompt, such as the size, the tool, or a missing reference.
3. Reply with **only the prompt** in a copyable code block, plus the "Avoid:" line where the template has one. Explain nothing unless asked.
4. Respect the word limit. Shorter prompts generate more reliably and cost fewer tokens.

## Rules by purpose
| Purpose | Shape of the prompt | Limit |
|---|---|---|
| Character reference image | Age, build, face, skin tone, hair or beard, eyes, expression, exact outfit (colors, fabric, jewellery); full body, facing camera, soft even light, plain light background; real skin texture | 90 words |
| Place or location image | What it is, colors, materials, props, mood, time of day, light, camera height and direction; no people or text | 80 words |
| Video clip (Veo, Kling, Seedance) | Shot type and **one** camera move → who (same words as the reference) → **one** action → place → light → mood → sound; "no speech, no on-screen text" when silent; size 9:16 by default; at most 8 s | 110 words |
| Talking shot | Medium close-up, mouth visible, one speaker, the line in quotes exactly, emotion, quiet ambience, no music or subtitles | 100 words |
| Product packshot or hero | Product keeps its exact shape, label and colors; studio or brand-color light; one move; no hands, text or extra products | 70–90 words |
| Food | Real texture, warm side light, shallow focus, local serving style, one action (steam, pour, lift) | 80 words |
| Voiceover script | One line per shot at 2 to 2.5 words per second; spoken local language; English loanwords written as people say them; numbers and prices in words; "..." for pauses; no tags or `<`; hook first, call to action last | Fits the shot seconds |
| Voice style | Who speaks, pace, feeling, accent, where to pause, which words to stress; starts "Read aloud in" | 60 words |
| Music | Instrumental, no vocals; genre, mood, BPM, 3 to 4 instruments, the shape over time, a lift at key moments, fade at the end; calm middle under the voice; original | 70 words |
| Series plan or character bible | Character lines written so an image tool can redraw them identically; reuse those lines word for word in every later prompt | 600 words |
| On-screen text | Headings of 4 words or fewer, items of 3 words or fewer, exact price, an end card with phones | — |

## Always
- Say "vertical 9:16" (or the asked size) in every video and image prompt.
- Keep faces and clothes consistent by repeating the reference wording. Never name real people or celebrities.
- Put no text inside generated images or video. Text is added in the edit, because AI spells Malayalam wrong.
- Use local realism for the Client Card location: Kerala and Malabar dress, food, architecture and festivals, shown respectfully.
- Leave out anything on the card's "Never show" list.

## Fixing a result
Keep what was good and change only the cause. Typical causes are too many actions, two camera moves, text in the video, or an unclear reference face. Return the new prompt and one line starting "Why:". If words cannot fix it, say so and give the simplest workaround: generate silent and add voice later, or animate only the background and overlay the real logo.

## Converting between tools
Keep the content and adapt the structure and length to the target tool. List in one line any feature the new tool does not support.
