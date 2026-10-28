---
name: video-ad-production
description: Run a client AI video ad from brief to delivered reel: Client Card, shot list, reference images, clips, Malayalam voice, music, edit, review and cut-downs.
---

# Video ad production (Cirqle Works)

The end-to-end workflow for an AI-made promotional video for a client (offer reels, wedding packages, shops, restaurants, products). Proven on the Seastar wedding ad: 9 clips, Malayalam female voice, animated text, logo, price badge, end card.

Related skills: `video-prompt-writer` writes every prompt, and `video-finishing` does the edit. The Cirqle app's **Prompt Studio** page holds the same templates and the saved Client Cards.

## Golden rules
- **The person clicks Generate in Google Flow, AI Studio and the music tools; Claude does not drive those sites.** Automating Flow triggers its "unusual activity" block and burns a lot of tokens. Claude writes the prompts and does the editing.
- Never bypass a site block, CAPTCHA or sign-in, and never enter passwords.
- One shot = one 8-second clip = one generation. Retry a bad clip with the *Fix a bad result* template, not the same words.
- Use the client's real photos (venue, food, product, logo) as references wherever possible. Real beats generated.
- Never invent offers, prices, phone numbers or claims. Copy them from the client's flyer or message and check them digit by digit.
- Model choice: Sonnet at low to medium effort for routine runs; Opus only when changing the template or pipeline.

## Folder per client
```
<Client>/<YYYY-MM> <campaign>/
  01 brief/       client message, flyer, Client Card (text)
  02 refs/        character + venue/product reference images
  03 clips/       shot01.mp4 ... (named by shot number)
  04 audio/       vo.wav, music.mp3
  05 edit/        overlay.html, frames/, working files
  06 final/       <Client>_<campaign>_9x16.mp4, _15s.mp4, _1x1.mp4
```

## Steps
1. **Brief → Client Card.** Paste the client's message into the *Client message to Client Card* template, or use the saved card in Prompt Studio. Mark anything missing as ASK CLIENT, and ask before going on if the price, phone or offer is missing.
2. **Concept.** Optional: write 3 *Ad concepts* and let the person pick one.
3. **Shot list.** Use the *Shot list* template: 6 to 9 shots, a hook in 2 seconds, offer and phones last, every "Must show" item covered.
4. **References.** Run *Character image* for each person and *Venue or place image* for each place. In Flow, save people as Characters (for example Bride, Groom) so faces stay consistent. Keep outfits locally right for the client: for Malabar Muslim weddings, the bride in a lehenga with gold jewellery and the groom in a black tuxedo or suit, bearded and stylish when asked.
5. **Clips.** Run *Video clip* once per shot with the references attached; settings are 9:16, 8 s, Veo 3.1 (Fast or Lite to save credits, Quality only for hero shots). The person generates, reviews, and downloads or merges in Flow Scenes (Add clip → Add media → export 720p or 1080p).
6. **Voice.** Use *Voiceover script* for one line per shot at about 2 to 2.5 words per second, with numbers written in words. Add *Voice style* on top. In Google AI Studio speech, voice Jori with a custom style worked well for warm female Malayalam. Do not type `<`, which opens the tag menu. Have a native speaker read the script once before generating.
7. **Music.** Use the *Background music* template for an instrumental track with no vocals. Generators (Gemini Create music, Lyria, Mureka) sometimes fail. If so, ask the person for a licensed MP3 and never use copyrighted film songs.
8. **On-screen text.** Use the *On-screen text and end card* template: headings of 4 words or fewer, tick items, price reveal, and an end card with logo, price, location, "Connect Now", phones and a terms line.
9. **Edit.** Follow the `video-finishing` skill: cut the clips to the voice lines, add the animated text layer, logo and price badge, mix the voice at −16 LUFS with music ducked about 12 dB, and fade the end.
10. **Review.** Run *Review before sending*: hook, must-show items, never-show items, spelling, price and phones, face consistency, readability on a phone, sync, and the call to action. Look at frames yourself before delivering.
11. **Deliver.** Send the 9:16 master, then the *Short cuts and other sizes* versions (15 s, 1:1). Use *Caption and hashtags* for the post copy.

## Budget and time (Seastar reference)
- Flow: about 10 credits per clip at the tier used. Plan for 1.5× the shot count in clips; Seastar used 24 clips for 9 kept, about 240 credits.
- First video took about 5 hours. With this system, aim for 70 to 90 minutes per video.
- Pricing ladder (Cirqle): Reel Basic ₹4–6k, Standard ₹8–12k, Premium ₹15–20k, retainer ₹20–30k a month.

## Done means
- Final MP4 in H.264 with AAC audio, the right size, loudness about −16 LUFS, and correct text and phones.
- The person has seen it, and the files are in the client folder (`06 final/`).
- Prompts that worked are saved to the Prompt Studio Library for the next similar client.
