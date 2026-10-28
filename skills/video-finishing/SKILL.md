---
name: video-finishing
description: Edit AI clips into a finished ad with ffmpeg: cut to the voiceover, animated Malayalam/English text layer, logo, price badge, end card, music ducking, loudness and cut-downs.
---

# Video finishing (ffmpeg + HTML text layer)

This turns generated clips, a voiceover WAV, optional music and the client's logo into a finished 9:16 ad. It was built for the Seastar wedding reel and is reusable for any client.

## Inputs (ask for anything missing)
- Clips, or one merged scene MP4 from Flow (720×1280, 24 fps).
- `vo.wav`, the voiceover, plus the script lines in order.
- `music.mp3` (optional, licensed or AI-generated, instrumental).
- Logo as a PNG, ideally transparent. If it only exists inside a flyer, look for a clean copy in the client folder before cropping a blurry one.
- Client Card facts: brand, offer, price, location, phones and colors. Copy them exactly.

Files may sit on the person's computer. Stage only what is needed, work in the workspace, and write results back to their folder.

## 1. Time the voice
Find the line starts from the pauses, then build a timeline `T = {s1:[start,end], …}` with one entry per line:
```bash
ffmpeg -i vo.wav -af silencedetect=noise=-35dB:d=0.35 -f null - 2>&1 | grep silence_
```
Add about 0.3 s lead-in (`adelay=300|300`). The last segment is the end card and runs about 5 s past the last word.

## 2. Cut the picture to the voice
One segment per line, using the best part of the matching shot. Write a `filter_complex` file:
```
[0:v]trim=10.5:15.0,setpts=(PTS-STARTPTS)*1,fps=24,format=yuv420p[v1];
...
[0:v]trim=28:32,setpts=(PTS-STARTPTS)*1.325,fps=24,format=yuv420p[v9];   # slow a short clip to fill its line
[0:v]trim=4:8,setpts=(PTS-STARTPTS)*1.425,fps=24,boxblur=6:1,eq=brightness=-0.08,format=yuv420p[v10];  # blurred end-card background
[v0][v1]...[v10]concat=n=11:v=1:a=0,fade=in:st=0:d=0.4[out]
```
Run `ffmpeg -i scene.mp4 -filter_complex_script base_filter.txt -map "[out]" -an -c:v libx264 -preset veryfast -crf 18 base.mp4`. Each segment's length must equal its timeline slot, and slowdowns should stay at 1.5× or less.

## 3. Animated text layer (HTML → transparent PNG frames)
- `overlay.html` at 720×1280 with a transparent background. Every element animates with CSS keyframes that use `animation-delay` from the timeline.
- Content:
  - Hero title on line 1.
  - Per-line lower-third headings with tick items.
  - Logo and price badge persistent in a corner.
  - Price reveal.
  - End card: logo, offer, price, location, "Connect Now", phones, "*Terms & conditions apply".
- Fonts are local woff2 files from fontsource (via cdn.jsdelivr.net/npm): Manjari or Noto Sans Malayalam for Malayalam, Poppins for English, and Playfair italic for accents. Wait for them before rendering:
```js
window.seek = t => document.getAnimations().forEach(a => { a.pause(); a.currentTime = t * 1000 })
window.ready = document.fonts.ready.then(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))))
```
- Render with Playwright (Chromium is preinstalled; do not reinstall Playwright). Use a 720×1280 viewport, call `seek(i/24)` for each frame, and save with `screenshot({ omitBackground: true })` as `frames/f_00000.png`. First render 6 or 8 check times and look at them: catch wrapped Malayalam lines, text behind the price box, and anything under 28 px.
- Safe area: keep text 60 px from the sides and out of the bottom 220 px, which Instagram's UI covers.

## 4. Composite and mix
```bash
ffmpeg -i base.mp4 -framerate 24 -i frames/f_%05d.png -i vo.wav [-stream_loop -1 -i music.mp3] -filter_complex "\
[0:v][1:v]overlay=0:0:format=auto[v];\
[2:a]adelay=300|300,highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-1.5:LRA=7[vo];\
[3:a]volume=-12dB,afade=t=out:st=<dur-3>:d=3[mu];[mu][vo]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=300[duck];\
[duck][vo]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5[a]" \
-map "[v]" -map "[a]" -t <dur> -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart final.mp4
```
Without music, skip the `[3:a]` chain and use `[vo]` as the output audio.

## 5. Check before sending
- `ffprobe` for duration, 720×1280 (or the target size), h264 and aac.
- Loudness: `ffmpeg -i final.mp4 -af ebur128 -f null -` should report an integrated value of about −16 LUFS.
- Pull 6 frames across the timeline and **look at them**: spelling, phone digits, the price, text inside the safe area, logo crisp.
- Listen to the first 5 seconds and the end card for sync.

## 6. Cut-downs
- **15 s:** hook, 3 strongest shots, price and the end card. Re-time the overlay timeline and re-render the frames.
- **1:1 or 4:5:** `crop` or `scale` + `pad` each segment, and move the text block into the new safe area.
- Name outputs `<Client>_<campaign>_9x16.mp4`, `_15s.mp4` and `_1x1.mp4`.

## Pitfalls already hit
- An AI music generator failing is common. Deliver the voice-only version and ask for an MP3 instead of waiting.
- Long Malayalam headlines wrap. Use `white-space: nowrap` and shrink the font size instead of letting them wrap.
- Encode H.264 at `-preset veryfast` unless the best quality is asked for.
