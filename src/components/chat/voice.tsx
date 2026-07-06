'use client'

/**
 * Voice notes UI (Cirqle Connect Wave C).
 *
 * <VoiceRecorderButton> — WhatsApp-style: hold to record, slide LEFT to
 * cancel, slide UP to lock hands-free (then Stop/Send buttons). Captures 64
 * amplitude peaks live via Web Audio so bubbles render waveforms instantly.
 * Records Opus/WebM at 32 kbps mono (~240 KB/min).
 *
 * <VoiceBubble> — waveform playback: scrubbable bars, 1×/1.5×/2× speed,
 * duration countdown, download, expandable transcript.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Send, Trash2, Download, Lock, FileText } from 'lucide-react'

const PEAK_COUNT = 64
const MAX_MS = 5 * 60 * 1000

export interface VoiceRecording {
  blob: Blob
  durationMs: number
  peaks: number[]
  mimeType: string
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ── Recorder ──────────────────────────────────────────────────────────────────

type RecState = 'idle' | 'recording' | 'locked'

export function VoiceRecorderButton({ disabled, onRecorded }: {
  disabled?: boolean
  onRecorded: (rec: VoiceRecording) => void
}) {
  const [state, setState] = useState<RecState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [slideHint, setSlideHint] = useState(0) // px dragged left (cancel progress)

  const mediaRef = useRef<{
    recorder: MediaRecorder
    stream: MediaStream
    ctx: AudioContext
    chunks: Blob[]
    rawPeaks: number[]
    startedAt: number
    timer: ReturnType<typeof setInterval>
    cancelled: boolean
  } | null>(null)
  const startPos = useRef<{ x: number; y: number } | null>(null)

  const cleanup = useCallback(() => {
    const m = mediaRef.current
    if (!m) return
    clearInterval(m.timer)
    try { if (m.recorder.state !== 'inactive') m.recorder.stop() } catch { /* already stopped */ }
    m.stream.getTracks().forEach(t => t.stop())
    void m.ctx.close().catch(() => {})
    mediaRef.current = null
  }, [])

  const start = useCallback(async () => {
    if (disabled || mediaRef.current) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      alert('Microphone access is needed for voice notes.')
      return
    }
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm'
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 })
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const buf = new Uint8Array(analyser.frequencyBinCount)

    const m = {
      recorder, stream, ctx, chunks: [] as Blob[], rawPeaks: [] as number[],
      startedAt: Date.now(), cancelled: false,
      timer: setInterval(() => {
        analyser.getByteTimeDomainData(buf)
        let max = 0
        for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i] - 128) / 128)
        m.rawPeaks.push(max)
        const ms = Date.now() - m.startedAt
        setElapsed(ms)
        if (ms >= MAX_MS) stopAndSend()
      }, 120),
    }
    recorder.ondataavailable = e => { if (e.data.size) m.chunks.push(e.data) }
    recorder.onstop = () => {
      const durationMs = Date.now() - m.startedAt
      if (!m.cancelled && durationMs >= 600) {
        // Downsample raw peaks → 64 buckets, normalized
        const raw = m.rawPeaks.length ? m.rawPeaks : [0]
        const peaks: number[] = []
        for (let i = 0; i < PEAK_COUNT; i++) {
          const a = Math.floor((i / PEAK_COUNT) * raw.length)
          const b = Math.max(a + 1, Math.floor(((i + 1) / PEAK_COUNT) * raw.length))
          peaks.push(Math.max(...raw.slice(a, b)))
        }
        const top = Math.max(0.15, ...peaks)
        onRecorded({
          blob: new Blob(m.chunks, { type: mimeType }),
          durationMs,
          peaks: peaks.map(p => p / top),
          mimeType,
        })
      }
      // cleanup of tracks/ctx happens in cleanup()
    }
    mediaRef.current = m
    recorder.start(250)
    setElapsed(0)
    setState('recording')

    function stopAndSend() { setState('idle'); setSlideHint(0); cleanup() }
  }, [disabled, onRecorded, cleanup])

  const finish = useCallback((cancel: boolean) => {
    const m = mediaRef.current
    if (!m) return
    m.cancelled = cancel
    setState('idle')
    setSlideHint(0)
    cleanup()
  }, [cleanup])

  // Pointer interactions (hold mode)
  const onPointerDown = (e: React.PointerEvent) => {
    if (state !== 'idle') return
    startPos.current = { x: e.clientX, y: e.clientY }
    void start()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (state !== 'recording' || !startPos.current) return
    const dx = e.clientX - startPos.current.x
    const dy = e.clientY - startPos.current.y
    setSlideHint(Math.min(0, dx))
    if (dx < -90) { finish(true); return }           // slide left → cancel
    if (dy < -60) { setState('locked'); setSlideHint(0) } // slide up → lock
  }
  const onPointerUp = () => {
    if (state === 'recording') finish(false) // release → send
    startPos.current = null
  }

  useEffect(() => cleanup, [cleanup]) // unmount safety

  if (state === 'idle') {
    return (
      <button
        onPointerDown={onPointerDown}
        disabled={disabled}
        className="touch-none select-none rounded p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
        aria-label="Hold to record a voice note"
        title="Hold to record · release to send · slide left to cancel · slide up for hands-free"
      >
        <Mic className="h-4 w-4" />
      </button>
    )
  }

  return (
    <div
      className="flex flex-1 touch-none select-none items-center gap-3"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={state === 'recording' ? onPointerUp : undefined}
    >
      <span className="flex items-center gap-1.5 text-sm text-red-500">
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
        {fmtDuration(elapsed)}
      </span>

      {state === 'recording' ? (
        <span className="flex-1 text-center text-xs text-muted-foreground" style={{ opacity: 1 + slideHint / 120 }}>
          ‹ slide to cancel · <Lock className="inline h-3 w-3" /> slide up to lock
        </span>
      ) : (
        <>
          <span className="flex-1 text-center text-xs text-muted-foreground">Recording… hands-free</span>
          <button onClick={() => finish(true)}
            className="rounded-lg border border-border p-2 text-muted-foreground hover:text-destructive" aria-label="Discard">
            <Trash2 className="h-4 w-4" />
          </button>
          <button onClick={() => finish(false)}
            className="rounded-lg bg-foreground p-2 text-background" aria-label="Send voice note">
            <Send className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  )
}

// ── Playback bubble ───────────────────────────────────────────────────────────

const SPEEDS = [1, 1.5, 2]

export function VoiceBubble({ url, durationMs, peaks, transcript, transcriptStatus, fileName }: {
  url: string | null
  durationMs: number
  peaks: number[]
  transcript: string | null
  transcriptStatus: string | null
  fileName?: string
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0) // 0..1
  const [speedIdx, setSpeedIdx] = useState(0)
  const [showTranscript, setShowTranscript] = useState(false)

  const bars = peaks.length ? peaks : Array.from({ length: PEAK_COUNT }, () => 0.4)

  const toggle = () => {
    const a = audioRef.current
    if (!a || !url) return
    if (playing) { a.pause(); return }
    a.playbackRate = SPEEDS[speedIdx]
    void a.play()
  }

  const cycleSpeed = () => {
    const next = (speedIdx + 1) % SPEEDS.length
    setSpeedIdx(next)
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next]
  }

  const scrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current
    if (!a || !url || !a.duration || !isFinite(a.duration)) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    a.currentTime = frac * a.duration
    setProgress(frac)
  }

  return (
    <div className="mt-1 w-full max-w-sm rounded-xl border border-border bg-muted/30 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <button onClick={toggle} disabled={!url}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-40"
          aria-label={playing ? 'Pause' : 'Play voice note'}>
          {playing
            ? <span className="flex gap-0.5"><span className="h-3 w-1 bg-background" /><span className="h-3 w-1 bg-background" /></span>
            : <span className="ml-0.5 h-0 w-0 border-y-[6px] border-l-[10px] border-y-transparent border-l-background" />}
        </button>

        {/* Waveform (scrubbable) */}
        <div className="flex h-8 flex-1 cursor-pointer items-center gap-[2px]" onClick={scrub} role="slider"
          aria-label="Seek" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          {bars.map((p, i) => (
            <span key={i}
              className={`w-[3px] flex-1 rounded-full transition-colors ${i / bars.length <= progress ? 'bg-foreground' : 'bg-muted-foreground/30'}`}
              style={{ height: `${Math.max(12, p * 100)}%` }} />
          ))}
        </div>

        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {fmtDuration(playing ? progress * durationMs : durationMs)}
        </span>
        <button onClick={cycleSpeed}
          className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground">
          {SPEEDS[speedIdx]}×
        </button>
        {url && (
          <a href={url} download={fileName ?? 'voice-note.webm'}
            className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Download voice note">
            <Download className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      {/* Transcript */}
      {transcriptStatus === 'pending' && (
        <p className="mt-1.5 animate-pulse text-xs text-muted-foreground">Transcribing…</p>
      )}
      {transcript && (
        <>
          <button onClick={() => setShowTranscript(v => !v)}
            className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <FileText className="h-3 w-3" /> {showTranscript ? 'Hide transcript' : 'Show transcript'}
          </button>
          {showTranscript && (
            <p className="mt-1 whitespace-pre-wrap text-xs italic text-foreground/80">“{transcript}”</p>
          )}
        </>
      )}

      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setProgress(0) }}
          onTimeUpdate={e => {
            const a = e.currentTarget
            if (a.duration && isFinite(a.duration)) setProgress(a.currentTime / a.duration)
          }}
          className="hidden"
        />
      )}
    </div>
  )
}
