'use client'

import { AlertTriangle } from 'lucide-react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Delete', onConfirm, onCancel }: ConfirmDialogProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-dp-error-container text-dp-error flex items-center justify-center shrink-0">
            <AlertTriangle size={20} />
          </div>
          <h2 className="font-sans text-[18px] font-bold text-dp-on-surface">{title}</h2>
        </div>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6">{message}</p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[14px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container transition-all cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-4 py-2 bg-dp-error text-white rounded-lg font-sans text-[14px] font-semibold hover:opacity-90 transition-all cursor-pointer"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
