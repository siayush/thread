import { create } from 'zustand'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface ConfirmOptions {
  title: string
  description?: string
  /** confirm-button label; defaults to 'Confirm' (or 'OK' for alerts) */
  confirmLabel?: string
  cancelLabel?: string
  /** styles the confirm button as destructive */
  destructive?: boolean
  /** alert mode: single OK button, no cancel */
  alert?: boolean
}

interface ConfirmState {
  open: boolean
  options: ConfirmOptions
  resolve: ((ok: boolean) => void) | null
}

const useConfirm = create<ConfirmState>(() => ({ open: false, options: { title: '' }, resolve: null }))

/** Themed replacement for window.confirm — resolves true when confirmed. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ open: true, options, resolve }))
}

/** Themed replacement for window.alert. */
export function alertDialog(title: string, description?: string): Promise<boolean> {
  return confirmDialog({ title, description, alert: true })
}

/** Renders the pending confirmDialog/alertDialog request; mounted once in App. */
export function ConfirmDialog(): JSX.Element {
  const open = useConfirm((s) => s.open)
  const options = useConfirm((s) => s.options)

  const close = (ok: boolean): void => {
    const { resolve } = useConfirm.getState()
    useConfirm.setState({ open: false, resolve: null })
    resolve?.(ok)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close(false)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{options.title}</DialogTitle>
          {options.description && <DialogDescription>{options.description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          {!options.alert && (
            <Button variant="ghost" onClick={() => close(false)}>
              {options.cancelLabel ?? 'Cancel'}
            </Button>
          )}
          <Button variant={options.destructive ? 'destructive' : 'default'} autoFocus onClick={() => close(true)}>
            {options.confirmLabel ?? (options.alert ? 'OK' : 'Confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
