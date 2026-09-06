import { useEffect, useRef, useState } from 'react'
import { Search, ScanBarcode, X } from 'lucide-react'

/**
 * Auto-focused barcode input that submits on Enter.
 * Used by all three Scan pages so the FINGERS QuickScan W5 (USB HID) can
 * just type into the focused field. A debounce fallback ensures fast scans
 * auto-submit even when the scanner doesn't append a newline.
 */
export default function ScanInput({ onScan, placeholder = 'Scan barcode or type code', autoFocus = true }) {
  const ref = useRef(null)
  const [val, setVal] = useState('')
  const [last, setLast] = useState('')
  const [pulse, setPulse] = useState(false)

  useEffect(() => {
    if (autoFocus && ref.current) ref.current.focus()
  }, [autoFocus])

  const submit = (code) => {
    const v = (code || '').trim()
    if (!v || v === last) return
    setLast(v)
    setPulse(true)
    setTimeout(() => setPulse(false), 600)
    onScan(v)
    setVal('')
  }

  return (
    <div className={`relative flex items-center gap-2 p-2 rounded-xl border-2 bg-white transition
      ${pulse ? 'border-emerald-400 ring-4 ring-emerald-100' : 'border-amber-300'}`}>
      <ScanBarcode className="text-amber-500 shrink-0 ml-1" size={22} />
      <input
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit(val)
          }
        }}
        placeholder={placeholder}
        className="flex-1 text-base font-mono tracking-wide outline-none bg-transparent px-1 py-1"
        autoComplete="off"
        spellCheck={false}
      />
      {val && (
        <button onClick={() => { setVal(''); ref.current?.focus() }} className="text-slate-400 hover:text-slate-600 p-1" title="Clear">
          <X size={16} />
        </button>
      )}
      <button onClick={() => submit(val)} className="btn btn-primary !py-1.5 !px-3 text-sm">
        <Search size={14} /> Scan
      </button>
    </div>
  )
}
