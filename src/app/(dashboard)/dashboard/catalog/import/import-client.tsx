'use client'

import { useState, useRef, useCallback } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Upload, FileSpreadsheet, ImageIcon, Package,
  Check, X, AlertCircle, Loader2, ChevronDown, ChevronUp,
  FileArchive, Info, Trash2,
} from 'lucide-react'
import { bulkImportProducts, getProductImageUploadUrl, saveProductImage } from '../actions'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParsedRow {
  _rowIndex: number
  name: string
  weight?: string
  category?: string
  brand?: string
  barcode?: string
  image_url?: string
  notes?: string
  // matched image file
  _matchedFile?: File
  _matchKey?: string  // how it was matched
}

// ── Column normalisation map ─────────────────────────────────────────────────

const COL_ALIASES: Record<string, keyof ParsedRow> = {
  name: 'name', 'product name': 'name', 'item name': 'name', 'product': 'name',
  weight: 'weight', size: 'weight', 'weight/size': 'weight', 'pack size': 'weight',
  category: 'category', 'product category': 'category', cat: 'category',
  brand: 'brand', manufacturer: 'brand', 'brand name': 'brand',
  barcode: 'barcode', ean: 'barcode', upc: 'barcode', sku: 'barcode', 'product code': 'barcode',
  image: 'image_url', 'image url': 'image_url', 'image link': 'image_url', photo: 'image_url',
  notes: 'notes', description: 'notes', note: 'notes',
}

function normaliseHeader(h: string): keyof ParsedRow | null {
  return COL_ALIASES[h.toLowerCase().trim()] || null
}

// ── SheetJS parser (loaded dynamically) ─────────────────────────────────────

async function parseSpreadsheet(file: File): Promise<ParsedRow[]> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
  if (raw.length < 2) return []

  const headers = (raw[0] as string[]).map(h => String(h))
  const colMap: Record<number, keyof ParsedRow> = {}
  headers.forEach((h, i) => {
    const key = normaliseHeader(h)
    if (key) colMap[i] = key
  })

  return raw.slice(1)
    .map((row, idx) => {
      const obj: ParsedRow = { _rowIndex: idx + 2, name: '' }
      row.forEach((cell: any, i: number) => {
        const key = colMap[i]
        if (key) (obj as any)[key] = String(cell ?? '').trim()
      })
      return obj
    })
    .filter(r => r.name)
}

async function parseCSV(file: File): Promise<ParsedRow[]> {
  const text = await file.text()
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim())
  const colMap: Record<number, keyof ParsedRow> = {}
  headers.forEach((h, i) => {
    const key = normaliseHeader(h)
    if (key) colMap[i] = key
  })
  return lines.slice(1).map((line, idx) => {
    const cells = line.split(',').map(c => c.replace(/^"|"$/g, '').trim())
    const obj: ParsedRow = { _rowIndex: idx + 2, name: '' }
    cells.forEach((cell, i) => {
      const key = colMap[i]
      if (key) (obj as any)[key] = cell
    })
    return obj
  }).filter(r => r.name)
}

// ── Match image files to rows ────────────────────────────────────────────────

function matchImages(rows: ParsedRow[], files: File[]): ParsedRow[] {
  const fileMap = new Map<string, File>()
  files.forEach(f => {
    const base = f.name.toLowerCase().replace(/\.[^.]+$/, '').trim()
    fileMap.set(base, f)
  })

  return rows.map(row => {
    // Try barcode match first
    if (row.barcode) {
      const barcodeKey = row.barcode.toLowerCase().trim()
      if (fileMap.has(barcodeKey)) {
        return { ...row, _matchedFile: fileMap.get(barcodeKey), _matchKey: 'barcode' }
      }
    }
    // Try name match
    const nameKey = row.name.toLowerCase().trim()
    if (fileMap.has(nameKey)) {
      return { ...row, _matchedFile: fileMap.get(nameKey), _matchKey: 'name' }
    }
    // Try partial name match
    for (const [key, file] of fileMap.entries()) {
      if (nameKey.includes(key) || key.includes(nameKey)) {
        return { ...row, _matchedFile: file, _matchKey: 'partial name' }
      }
    }
    return row
  })
}

// ── Upload image for a product ───────────────────────────────────────────────

async function uploadImageForProduct(productId: string, file: File): Promise<void> {
  const urlRes = await getProductImageUploadUrl(productId, file.name, file.type)
  if (!urlRes.ok || !urlRes.data) return
  const { uploadUrl, publicUrl, storagePath } = urlRes.data
  const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
  if (res.ok) await saveProductImage(productId, publicUrl, storagePath, 'original', true)
}

// ── Step indicators ───────────────────────────────────────────────────────────

function Step({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <div className={`flex items-center gap-2 text-sm ${active ? 'text-foreground font-semibold' : done ? 'text-violet-400' : 'text-muted-foreground/40'}`}>
      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border transition-colors ${
        done ? 'bg-violet-500 border-violet-500 text-white' : active ? 'border-violet-500 text-violet-400' : 'border-border'
      }`}>
        {done ? <Check className="w-3 h-3" /> : n}
      </div>
      {label}
    </div>
  )
}

// ── Preview table ─────────────────────────────────────────────────────────────

function PreviewTable({ rows, imageFiles, onRemove }: {
  rows: ParsedRow[]
  imageFiles: File[]
  onRemove: (idx: number) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const matched = matchImages(rows, imageFiles)
  const visible = showAll ? matched : matched.slice(0, 20)
  const matchedCount = matched.filter(r => r._matchedFile).length

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-foreground">
          {rows.length} products · {matchedCount} with images matched
        </p>
        {matchedCount > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            {matchedCount}/{rows.length} images matched
          </span>
        )}
      </div>
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-secondary border-b border-border">
                <th className="text-left px-3 py-2 text-muted-foreground font-medium w-6">#</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Name</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Weight</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Category</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Brand</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Barcode</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Image</th>
                <th className="w-8 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row, i) => (
                <tr key={i} className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors">
                  <td className="px-3 py-2 text-muted-foreground/50">{row._rowIndex}</td>
                  <td className="px-3 py-2 font-medium text-foreground max-w-40 truncate">{row.name}</td>
                  <td className="px-3 py-2 text-muted-foreground">{row.weight || '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground">{row.category || '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground">{row.brand || '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground font-mono text-[10px]">{row.barcode || '—'}</td>
                  <td className="px-3 py-2">
                    {row._matchedFile ? (
                      <span className="flex items-center gap-1 text-emerald-400">
                        <Check className="w-3 h-3" />
                        <span className="truncate max-w-24">{row._matchedFile.name}</span>
                        <span className="text-[9px] text-muted-foreground/40">({row._matchKey})</span>
                      </span>
                    ) : row.image_url ? (
                      <span className="text-violet-400 text-[10px] truncate max-w-28">URL</span>
                    ) : (
                      <span className="text-muted-foreground/30">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => onRemove(i)} className="p-1 rounded hover:bg-red-500/10 text-muted-foreground/30 hover:text-red-400 transition-colors">
                      <X className="w-3 h-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > 20 && (
          <button
            onClick={() => setShowAll(a => !a)}
            className="w-full py-2 text-xs text-muted-foreground hover:text-foreground border-t border-border flex items-center justify-center gap-1 bg-secondary/30 hover:bg-secondary/60 transition-colors"
          >
            {showAll ? <><ChevronUp className="w-3 h-3" /> Show fewer</> : <><ChevronDown className="w-3 h-3" /> Show all {rows.length} rows</>}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

type Stage = 'upload' | 'preview' | 'importing' | 'done'

export default function ImportClient() {
  const [stage, setStage] = useState<Stage>('upload')
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [imageFiles, setImageFiles] = useState<File[]>([])
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState('')
  const [importResult, setImportResult] = useState<{ inserted: number; skipped: number; errors: string[]; imagesFailed: number } | null>(null)
  const [progress, setProgress] = useState({ done: 0, total: 0, phase: '' })
  const [dragOver, setDragOver] = useState<'sheet' | 'images' | null>(null)

  const sheetRef = useRef<HTMLInputElement>(null)
  const imagesRef = useRef<HTMLInputElement>(null)

  // ── File handlers ───────────────────────────────────────────────────────────

  async function handleSheetFile(file: File) {
    setParsing(true); setParseError(''); setRows([])
    try {
      let parsed: ParsedRow[]
      if (file.name.endsWith('.csv')) {
        parsed = await parseCSV(file)
      } else {
        parsed = await parseSpreadsheet(file)
      }
      if (!parsed.length) { setParseError('No valid rows found. Make sure row 1 is a header row and column "Name" exists.'); setParsing(false); return }
      setRows(parsed)
      setStage('preview')
    } catch (e: any) {
      setParseError(`Could not parse file: ${e.message}`)
    }
    setParsing(false)
  }

  async function handleImageFiles(files: FileList | File[]) {
    const arr = Array.from(files)
    const zipFiles = arr.filter(f => f.name.endsWith('.zip'))
    const imgFiles = arr.filter(f => f.type.startsWith('image/'))

    // Extract ZIPs using JSZip
    let extractedImgs: File[] = [...imgFiles]
    if (zipFiles.length > 0) {
      try {
        const JSZip = (await import('jszip')).default
        for (const zip of zipFiles) {
          const zipped = await JSZip.loadAsync(await zip.arrayBuffer())
          for (const [filename, entry] of Object.entries(zipped.files)) {
            if (entry.dir) continue
            const ext = filename.split('.').pop()?.toLowerCase()
            if (!['jpg','jpeg','png','webp','gif','avif'].includes(ext || '')) continue
            const blob = await entry.async('blob')
            const baseName = filename.split('/').pop() || filename
            extractedImgs.push(new File([blob], baseName, { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` }))
          }
        }
      } catch {
        // ZIP parsing failed — just use the image files we have
      }
    }
    setImageFiles(prev => {
      const names = new Set(prev.map(f => f.name))
      return [...prev, ...extractedImgs.filter(f => !names.has(f.name))]
    })
  }

  function removeRow(i: number) {
    setRows(prev => prev.filter((_, idx) => idx !== i))
  }

  // ── Drag & drop ─────────────────────────────────────────────────────────────

  const handleSheetDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(null)
    const file = e.dataTransfer.files[0]
    if (file) await handleSheetFile(file)
  }, [])

  const handleImageDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(null)
    await handleImageFiles(e.dataTransfer.files)
  }, [])

  // ── Import ──────────────────────────────────────────────────────────────────

  async function runImport() {
    setStage('importing')
    const matched = matchImages(rows, imageFiles)

    // 1. Bulk insert products
    setProgress({ done: 0, total: matched.length, phase: 'Saving products…' })
    const importRes = await bulkImportProducts(
      matched.map(r => ({
        name: r.name,
        weight: r.weight,
        category: r.category,
        brand: r.brand,
        barcode: r.barcode,
        image_url: r.image_url,
        notes: r.notes,
      }))
    )

    if (!importRes.ok && !importRes.data) {
      setImportResult({ inserted: 0, skipped: 0, errors: [importRes.error || 'Import failed'], imagesFailed: 0 })
      setStage('done')
      return
    }

    const { inserted = 0, skipped = 0, errors = [] } = importRes.data || {}

    // 2. Upload images — we need the product IDs. Re-fetch them by barcode/name.
    const withImages = matched.filter(r => r._matchedFile)
    let imagesFailed = 0

    if (withImages.length > 0) {
      setProgress({ done: 0, total: withImages.length, phase: 'Uploading images…' })
      // Fetch newly inserted products to get their IDs
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      for (let i = 0; i < withImages.length; i++) {
        const row = withImages[i]
        const file = row._matchedFile!

        // Find the product by barcode then name
        let productId: string | null = null
        if (row.barcode) {
          const { data } = await supabase.from('product_catalog').select('id').eq('barcode', row.barcode).maybeSingle()
          productId = data?.id || null
        }
        if (!productId) {
          const { data } = await supabase.from('product_catalog').select('id').ilike('name', row.name).maybeSingle()
          productId = data?.id || null
        }

        if (productId) {
          try {
            await uploadImageForProduct(productId, file)
          } catch {
            imagesFailed++
          }
        } else {
          imagesFailed++
        }

        setProgress({ done: i + 1, total: withImages.length, phase: 'Uploading images…' })
      }
    }

    setImportResult({ inserted, skipped, errors, imagesFailed })
    setStage('done')
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-border">
        <div className="flex items-center gap-3 mb-1">
          <Link href="/dashboard/catalog" className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <h1 className="text-xl font-bold">Bulk Import</h1>
        </div>
        <p className="text-sm text-muted-foreground ml-9">Upload a spreadsheet + images to add products to the global catalog</p>

        {/* Steps */}
        <div className="flex items-center gap-4 mt-4 ml-9 flex-wrap">
          <Step n={1} label="Upload spreadsheet" active={stage === 'upload'} done={stage !== 'upload'} />
          <div className="h-px w-6 bg-border" />
          <Step n={2} label="Match images" active={stage === 'preview'} done={stage === 'importing' || stage === 'done'} />
          <div className="h-px w-6 bg-border" />
          <Step n={3} label="Import" active={stage === 'importing'} done={stage === 'done'} />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-6 max-w-4xl">

        {/* ── Stage: upload ─────────────────────────────────────────────────── */}
        {stage === 'upload' && (
          <div className="space-y-6">
            {/* Spreadsheet drop zone */}
            <div>
              <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-violet-400" /> Step 1 — Upload product list
              </h2>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver('sheet') }}
                onDragLeave={() => setDragOver(null)}
                onDrop={handleSheetDrop}
                onClick={() => sheetRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl px-6 py-12 flex flex-col items-center justify-center cursor-pointer transition-colors ${
                  dragOver === 'sheet' ? 'border-violet-500 bg-violet-500/5' : 'border-border hover:border-violet-500/40 hover:bg-secondary/30'
                }`}
              >
                {parsing ? (
                  <><Loader2 className="w-8 h-8 text-violet-400 animate-spin mb-3" /><p className="text-sm text-muted-foreground">Parsing…</p></>
                ) : (
                  <>
                    <Upload className="w-8 h-8 text-muted-foreground/30 mb-3" />
                    <p className="text-sm font-semibold text-foreground mb-1">Drop your Excel or CSV file here</p>
                    <p className="text-xs text-muted-foreground">or click to browse · .xlsx, .xls, .csv accepted</p>
                  </>
                )}
              </div>
              <input ref={sheetRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={e => e.target.files?.[0] && handleSheetFile(e.target.files[0])} />
              {parseError && (
                <p className="mt-2 text-xs text-red-400 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" />{parseError}</p>
              )}
            </div>

            {/* Column format hint */}
            <div className="bg-secondary/40 border border-border rounded-xl p-4">
              <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5"><Info className="w-3.5 h-3.5" /> Expected column names (any order, case-insensitive)</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                {[
                  ['Name *', 'required'],
                  ['Weight / Size', 'e.g. 1L, 5kg'],
                  ['Category', 'e.g. Oils & Fats'],
                  ['Brand', 'e.g. Fortune'],
                  ['Barcode / EAN / SKU', 'for image matching'],
                  ['Image URL', 'optional direct link'],
                  ['Notes', 'internal notes'],
                ].map(([col, hint]) => (
                  <div key={col} className="flex flex-col">
                    <span className="font-medium text-foreground">{col}</span>
                    <span className="text-muted-foreground/50">{hint}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Stage: preview ────────────────────────────────────────────────── */}
        {stage === 'preview' && (
          <div className="space-y-6">
            {/* Image upload */}
            <div>
              <h2 className="text-sm font-semibold mb-1 flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-violet-400" /> Step 2 — Upload product images <span className="text-muted-foreground/40 font-normal">(optional)</span>
              </h2>
              <p className="text-xs text-muted-foreground mb-3">
                Name image files to match your products — by barcode (e.g. <code className="bg-secondary px-1 rounded">8901234.jpg</code>) or product name (e.g. <code className="bg-secondary px-1 rounded">Sunflower Oil 1L.png</code>). You can also upload a ZIP.
              </p>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver('images') }}
                onDragLeave={() => setDragOver(null)}
                onDrop={handleImageDrop}
                onClick={() => imagesRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl px-6 py-8 flex flex-col items-center justify-center cursor-pointer transition-colors ${
                  dragOver === 'images' ? 'border-violet-500 bg-violet-500/5' : 'border-border hover:border-violet-500/40 hover:bg-secondary/30'
                }`}
              >
                <div className="flex items-center gap-3 mb-2 text-muted-foreground/30">
                  <ImageIcon className="w-6 h-6" />
                  <FileArchive className="w-6 h-6" />
                </div>
                <p className="text-sm font-semibold text-foreground mb-0.5">Drop images or a ZIP here</p>
                <p className="text-xs text-muted-foreground">JPG, PNG, WebP or a ZIP containing images</p>
              </div>
              <input ref={imagesRef} type="file" accept="image/*,.zip" multiple className="hidden"
                onChange={e => e.target.files && handleImageFiles(e.target.files)} />

              {imageFiles.length > 0 && (
                <div className="mt-3 flex items-center gap-3 flex-wrap">
                  <span className="text-xs text-muted-foreground">{imageFiles.length} image{imageFiles.length !== 1 ? 's' : ''} loaded</span>
                  <div className="flex gap-1.5 flex-wrap">
                    {imageFiles.slice(0, 8).map(f => (
                      <span key={f.name} className="text-[10px] px-1.5 py-0.5 bg-secondary rounded border border-border text-muted-foreground truncate max-w-28">{f.name}</span>
                    ))}
                    {imageFiles.length > 8 && <span className="text-[10px] text-muted-foreground/50">+{imageFiles.length - 8} more</span>}
                  </div>
                  <button onClick={() => setImageFiles([])} className="text-xs text-red-400 hover:underline flex items-center gap-1">
                    <Trash2 className="w-3 h-3" /> Clear
                  </button>
                </div>
              )}
            </div>

            {/* Preview table */}
            <PreviewTable rows={rows} imageFiles={imageFiles} onRemove={removeRow} />

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={runImport}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl gradient-bg text-white hover:opacity-90 transition-opacity"
              >
                <Package className="w-4 h-4" /> Import {rows.length} products
              </button>
              <button
                onClick={() => { setStage('upload'); setRows([]); setImageFiles([]) }}
                className="px-4 py-2.5 text-sm rounded-xl bg-secondary border border-border hover:bg-secondary/70 text-muted-foreground"
              >
                Start over
              </button>
            </div>
          </div>
        )}

        {/* ── Stage: importing ─────────────────────────────────────────────── */}
        {stage === 'importing' && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Loader2 className="w-10 h-10 text-violet-400 animate-spin mb-4" />
            <p className="text-base font-semibold mb-1">{progress.phase}</p>
            {progress.total > 0 && (
              <>
                <p className="text-sm text-muted-foreground mb-4">{progress.done} / {progress.total}</p>
                <div className="w-64 h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className="h-full gradient-bg rounded-full transition-all" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Stage: done ──────────────────────────────────────────────────── */}
        {stage === 'done' && importResult && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-4">
              <Check className="w-6 h-6 text-emerald-400" />
            </div>
            <h2 className="text-lg font-bold mb-1">Import complete</h2>
            <div className="flex items-center gap-4 text-sm text-muted-foreground mb-6">
              <span><span className="text-foreground font-semibold">{importResult.inserted}</span> products added</span>
              {importResult.skipped > 0 && <span><span className="text-amber-400 font-semibold">{importResult.skipped}</span> skipped</span>}
              {importResult.imagesFailed > 0 && <span><span className="text-red-400 font-semibold">{importResult.imagesFailed}</span> images failed</span>}
            </div>
            {importResult.errors.length > 0 && (
              <div className="mb-6 text-left w-full max-w-md bg-red-500/5 border border-red-500/20 rounded-xl p-4">
                <p className="text-xs font-semibold text-red-400 mb-2">Errors</p>
                {importResult.errors.map((e, i) => <p key={i} className="text-xs text-red-600/80 dark:text-red-300/70">{e}</p>)}
              </div>
            )}
            <div className="flex gap-3">
              <Link href="/dashboard/catalog"
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl gradient-bg text-white hover:opacity-90">
                <Package className="w-4 h-4" /> View catalog
              </Link>
              <button onClick={() => { setStage('upload'); setRows([]); setImageFiles([]); setImportResult(null) }}
                className="px-4 py-2.5 text-sm rounded-xl bg-secondary border border-border hover:bg-secondary/70 text-muted-foreground">
                Import more
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
