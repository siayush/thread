import { useEffect, useState, type ReactNode } from 'react'
import { useUi, THEMES, DEFAULT_THEME, DEFAULT_DIFF_VIEW, type ThemeId } from '../state/uiStore'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { ArrowLeft, Info, RotateCcw, SlidersHorizontal } from 'lucide-react'

type SectionId = 'general' | 'about'

const NAV: { id: SectionId; label: string; icon: typeof SlidersHorizontal }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'about', label: 'About', icon: Info }
]

/** A settings row: title + description on the left, its control on the right. */
function Row({ title, description, children }: { title: string; description: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-8 py-5">
      <div className="min-w-0">
        <div className="text-[15px] font-medium text-foreground">{title}</div>
        <p className="mt-1 max-w-md text-[13px] leading-snug text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function GeneralSection(): JSX.Element {
  const theme = useUi((s) => s.theme)
  const setTheme = useUi((s) => s.setTheme)
  const diffView = useUi((s) => s.diffView)
  const setDiffView = useUi((s) => s.setDiffView)

  return (
    <div className="divide-y divide-border">
      <Row
        title="Theme"
        description="Choose how Thread looks across the app. Both themes are dark; they differ in how black the background is."
      >
        <Select value={theme} onValueChange={(v) => v && setTheme(v as ThemeId)}>
          <SelectTrigger className="w-44">
            <SelectValue>{(v) => THEMES.find((t) => t.id === v)?.label ?? String(v)}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end" alignItemWithTrigger={false}>
            {THEMES.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <Row
        title="Default diff view"
        description="How file changes open in the diff panel — side-by-side or a single inline column."
      >
        <Select value={diffView} onValueChange={(v) => v && setDiffView(v as 'inline' | 'split')}>
          <SelectTrigger className="w-44">
            <SelectValue>{(v) => (v === 'split' ? 'Split' : 'Inline')}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end" alignItemWithTrigger={false}>
            <SelectItem value="inline">Inline</SelectItem>
            <SelectItem value="split">Split</SelectItem>
          </SelectContent>
        </Select>
      </Row>

    </div>
  )
}

function AboutSection(): JSX.Element {
  return (
    <div className="py-5">
      <div className="flex items-center gap-3">
        <div className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
          <span className="text-lg font-semibold">T</span>
        </div>
        <div>
          <div className="text-[15px] font-semibold text-foreground">Thread</div>
          <div className="text-[13px] text-muted-foreground">Version 0.2.0</div>
        </div>
      </div>
      <p className="mt-4 max-w-md text-[13px] leading-relaxed text-muted-foreground">
        A desktop workspace for running coding agents across your projects — organise work into threads, review diffs, and
        ship changes without leaving the app.
      </p>
    </div>
  )
}

/** Full-screen settings, laid out as a left nav + a scrolling content pane. */
export function SettingsPage(): JSX.Element | null {
  const open = useUi((s) => s.settingsOpen)
  const setOpen = useUi((s) => s.setSettingsOpen)
  const setTheme = useUi((s) => s.setTheme)
  const setDiffView = useUi((s) => s.setDiffView)
  const [section, setSection] = useState<SectionId>('general')

  // Escape closes settings, matching the diff and file views
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  const restoreDefaults = (): void => {
    setTheme(DEFAULT_THEME)
    setDiffView(DEFAULT_DIFF_VIEW)
  }

  const active = NAV.find((n) => n.id === section) ?? NAV[0]

  return (
    <div className="animate-in fade-in fixed inset-0 z-50 flex bg-background duration-150">
      {/* left nav */}
      <aside className="flex w-64 shrink-0 flex-col border-r bg-card">
        <div className="drag-region flex h-13 items-center pr-4 pl-19">
          <span className="text-sm font-semibold tracking-tight text-foreground">Settings</span>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {NAV.map((n) => {
            const Icon = n.icon
            const isActive = n.id === section
            return (
              <Button
                key={n.id}
                variant="ghost"
                onClick={() => setSection(n.id)}
                className={cn(
                  'h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-normal',
                  isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 dark:hover:bg-muted/60'
                )}
              >
                <Icon className="size-[15px]" />
                {n.label}
              </Button>
            )
          })}
        </nav>
        <div className="border-t p-2">
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-2 px-2.5 py-2 text-[13px] font-normal text-muted-foreground"
            onClick={() => setOpen(false)}
          >
            <ArrowLeft className="size-[15px]" />
            Back
          </Button>
        </div>
      </aside>

      {/* content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="drag-region flex h-13 items-center justify-end pr-5 pl-5">
          <Button variant="ghost" size="sm" className="no-drag gap-1.5 text-muted-foreground" onClick={restoreDefaults}>
            <RotateCcw className="size-[13px]" />
            Restore defaults
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-8 pb-16">
            <h1 className="pt-2 pb-2 text-2xl font-semibold tracking-tight text-foreground">{active.label}</h1>
            {section === 'general' && <GeneralSection />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  )
}
