/**
 * In-browser product-photo background removal — free, no per-image API cost.
 *
 * Runs the U²-Net-lite (u2netp) salient-object model via onnxruntime-web
 * (MIT) entirely on the user's device. Both the model (Apache-2.0) and the
 * WASM runtime are served from our own /public, so there is no external CDN
 * or paid service in the loop. First call downloads ~18MB (model + wasm),
 * cached by the browser; after that each image takes a couple of seconds.
 *
 * Output is a PNG with a transparent background, sized like the input
 * (capped at MAX_DIM so a 6000px camera photo doesn't blow up memory).
 */

const MODEL_URL = '/models/u2netp.onnx'
const ORT_WASM_DIR = '/models/ort/'
const MODEL_SIZE = 320       // u2netp input resolution
const MAX_DIM = 2000         // cap output resolution

// The ONNX session is expensive to create — keep one per tab. A failed init
// clears the promise so a retry can succeed (e.g. flaky network on the model
// download).
let sessionPromise: Promise<{
  ort: typeof import('onnxruntime-web')
  session: import('onnxruntime-web').InferenceSession
}> | null = null

function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // The cpu-only build — matches the plain (non-JSEP) wasm binary we ship
      // in /public/models/ort/. The default export would request the WebGPU
      // (jsep) wasm variant instead.
      const ort = await import('onnxruntime-web/wasm')
      ort.env.wasm.wasmPaths = ORT_WASM_DIR
      // Single-threaded: multi-threading needs cross-origin isolation (COOP/
      // COEP headers) which the app doesn't set. u2netp is small enough.
      ort.env.wasm.numThreads = 1
      const session = await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ['wasm'],
      })
      return { ort, session }
    })()
    sessionPromise.catch(() => { sessionPromise = null })
  }
  return sessionPromise
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D not available')
  return { canvas, ctx }
}

/**
 * Remove the background from an image blob. Returns a transparent PNG blob.
 * Throws with a human-readable message on failure.
 */
export async function removeBackground(imageBlob: Blob): Promise<Blob> {
  const { ort, session } = await getSession()

  const bitmap = await createImageBitmap(imageBlob)
  try {
    // Working size (capped)
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height))
    const outW = Math.max(1, Math.round(bitmap.width * scale))
    const outH = Math.max(1, Math.round(bitmap.height * scale))

    // 1. Preprocess: letterbox-free resize to 320×320, ImageNet normalisation
    //    (matches how the model was trained / how rembg feeds it).
    const { ctx: inCtx } = makeCanvas(MODEL_SIZE, MODEL_SIZE)
    inCtx.drawImage(bitmap, 0, 0, MODEL_SIZE, MODEL_SIZE)
    const inData = inCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data

    const plane = MODEL_SIZE * MODEL_SIZE
    const input = new Float32Array(3 * plane)
    for (let i = 0; i < plane; i++) {
      input[i]             = (inData[i * 4]     / 255 - 0.485) / 0.229
      input[plane + i]     = (inData[i * 4 + 1] / 255 - 0.456) / 0.224
      input[2 * plane + i] = (inData[i * 4 + 2] / 255 - 0.406) / 0.225
    }

    // 2. Run the model. First declared output (d0) is the fused mask.
    const tensor = new ort.Tensor('float32', input, [1, 3, MODEL_SIZE, MODEL_SIZE])
    const results = await session.run({ [session.inputNames[0]]: tensor })
    const mask = results[session.outputNames[0]].data as Float32Array

    // 3. Min-max normalise the mask to 0..255 alpha.
    let min = Infinity, max = -Infinity
    for (let i = 0; i < plane; i++) {
      const v = mask[i]
      if (v < min) min = v
      if (v > max) max = v
    }
    const range = max - min || 1
    const maskImage = new ImageData(MODEL_SIZE, MODEL_SIZE)
    for (let i = 0; i < plane; i++) {
      const a = Math.round(((mask[i] - min) / range) * 255)
      maskImage.data[i * 4] = 255
      maskImage.data[i * 4 + 1] = 255
      maskImage.data[i * 4 + 2] = 255
      maskImage.data[i * 4 + 3] = a
    }

    // 4. Upscale the mask to output size (browser bilinear smoothing gives us
    //    soft edges for free), then apply it as the alpha channel.
    const { canvas: maskSmall, ctx: maskSmallCtx } = makeCanvas(MODEL_SIZE, MODEL_SIZE)
    maskSmallCtx.putImageData(maskImage, 0, 0)
    const { ctx: maskCtx } = makeCanvas(outW, outH)
    maskCtx.imageSmoothingEnabled = true
    maskCtx.imageSmoothingQuality = 'high'
    maskCtx.drawImage(maskSmall, 0, 0, outW, outH)
    const maskData = maskCtx.getImageData(0, 0, outW, outH).data

    const { canvas: outCanvas, ctx: outCtx } = makeCanvas(outW, outH)
    outCtx.drawImage(bitmap, 0, 0, outW, outH)
    const out = outCtx.getImageData(0, 0, outW, outH)
    for (let i = 0; i < outW * outH; i++) {
      out.data[i * 4 + 3] = maskData[i * 4 + 3]
    }
    outCtx.putImageData(out, 0, 0)

    const blob = await new Promise<Blob | null>(resolve => outCanvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Could not encode the result image')
    return blob
  } finally {
    bitmap.close()
  }
}
