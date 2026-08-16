import { useState } from 'react'
import anthropicIcon from '@resources/icons/anthropic.svg?raw'
import openaiIcon from '@resources/icons/openai.svg?raw'
import type { ProviderKind, Thread } from '@shared/domain'
import { useServer } from '../state/serverStore'
import { Command as CommandPrimitive } from 'cmdk'
import { ChevronDown, LayoutGrid, Search, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'

interface Vendor {
  id: 'anthropic' | 'openai'
  name: string
  /** raw SVG markup from resources/icons — files use fill="currentColor" so they tint like lucide icons */
  iconSvg: string
  /** brand tint applied to the icon; undefined = inherit text color */
  colorCls?: string
  providers: ProviderKind[]
}

const VENDORS: Vendor[] = [
  { id: 'anthropic', name: 'Anthropic', iconSvg: anthropicIcon, colorCls: 'text-foreground', providers: ['claude'] },
  { id: 'openai', name: 'OpenAI', iconSvg: openaiIcon, colorCls: 'text-foreground', providers: ['codexAgent'] }
]

const VENDOR_OF: Record<ProviderKind, Vendor> = {
  claude: VENDORS[0],
  codexAgent: VENDORS[1]
}

/** product name shown under the model ("Claude", "Codex") */
const PRODUCT_LABEL: Record<ProviderKind, string> = {
  claude: 'Claude',
  codexAgent: 'Codex'
}

/**
 * Display name: our labels are "Provider — Name" (e.g. "Codex API —
 * GPT-5"); the provider qualifier is redundant in the picker because the
 * sub-label row already names it, so show just the model name.
 */
function displayModelName(label: string): string {
  return label.replace(/^.*?\s—\s/, '')
}

/** The collapsed trigger shows this model's name + icon for the "default" entry
 *  (never a bare "Default"); the dropdown still lists the real "Default" row. */
const DEFAULT_TRIGGER_MODEL = 'claude-opus-4-8'

function BrandIcon({ svg, className }: { svg: string; className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn('inline-flex size-4 shrink-0 [&>svg]:size-full', className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

export function ModelPicker({ thread }: { thread: Thread }): JSX.Element {
  const dispatch = useServer((s) => s.dispatch)
  const models = useServer((s) => s.models)
  const [open, setOpen] = useState(false)
  const [vendorFilter, setVendorFilter] = useState<'all' | Vendor['id']>('all')
  const [query, setQuery] = useState('')

  // `thread.model === null` means the "default" picker entry (Claude CLI default)
  const current = models.find((m) => (thread.model ? m.value === thread.model : m.value === 'default')) ?? null
  const triggerModel =
    current?.value === 'default'
      ? (models.find((m) => m.value === DEFAULT_TRIGGER_MODEL) ?? current)
      : current
  const triggerVendor = triggerModel ? VENDOR_OF[triggerModel.provider] : null

  const visible =
    vendorFilter === 'all' ? models : models.filter((m) => VENDOR_OF[m.provider].id === vendorFilter)

  const isSelected = (value: string): boolean =>
    thread.model ? thread.model === value : value === 'default'

  const pick = (value: string): void => {
    // reset effort to the new model's default so an unsupported level never carries over
    const picked = models.find((m) => m.value === value)
    void dispatch({
      type: 'thread.setConfig',
      threadId: thread.id,
      model: value === 'default' ? null : value,
      reasoningEffort: picked?.defaultReasoningEffort ?? null
    })
    setOpen(false)
  }

  // the provider rail hides while a search is active — results span all vendors
  const showRail = query.trim() === ''

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQuery('')
      }}
    >
      {/* React 18 strips `ref` on plain function components, so render-merging the
          shadcn <Button> here breaks Base UI's trigger registration (popover would
          close immediately). Style the native trigger button instead. */}
      <PopoverTrigger
        className={cn(
          buttonVariants({ variant: 'ghost' }),
          'h-7 gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground dark:hover:bg-accent'
        )}
      >
        {triggerVendor ? (
          <BrandIcon svg={triggerVendor.iconSvg} className={cn('size-[13px]', triggerVendor.colorCls)} />
        ) : (
          <Sparkles className="size-[13px]" />
        )}
        {triggerModel ? displayModelName(triggerModel.label) : 'Default'}
        <ChevronDown className="size-3 text-muted-foreground" />
      </PopoverTrigger>

      {/* glass panel: fixed 360×346, provider rail | search + list */}
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-[360px] gap-0 overflow-hidden p-0 bg-popover/85 shadow-[0_18px_44px_-18px_rgba(0,0,0,0.8)] backdrop-blur-[16px] backdrop-saturate-[1.08]"
      >
        <div className="flex h-[346px]">
          {/* provider rail — selection shown as a primary pill on the rail's right edge */}
          {showRail && (
            <div className="flex w-11 shrink-0 flex-col gap-1 overflow-y-auto bg-muted/30 p-1">
              <Button
                variant="ghost"
                title="All models"
                className={cn(
                  'relative aspect-square h-auto w-full rounded-md p-0 text-muted-foreground hover:text-foreground',
                  vendorFilter === 'all' && 'text-foreground'
                )}
                onClick={() => setVendorFilter('all')}
              >
                <LayoutGrid className="size-[18px]" />
                {vendorFilter === 'all' && (
                  <span className="pointer-events-none absolute -right-1 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-l-full bg-primary" />
                )}
              </Button>
              {VENDORS.map((v) => (
                <Button
                  key={v.id}
                  variant="ghost"
                  title={v.name}
                  className={cn(
                    'relative aspect-square h-auto w-full rounded-md p-0 text-muted-foreground hover:text-foreground',
                    vendorFilter === v.id && 'text-foreground'
                  )}
                  onClick={() => setVendorFilter(v.id)}
                >
                  <BrandIcon svg={v.iconSvg} className="size-[18px]" />
                  {vendorFilter === v.id && (
                    <span className="pointer-events-none absolute -right-1 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-l-full bg-primary" />
                  )}
                </Button>
              ))}
            </div>
          )}

          {/* searchable model list */}
          <div className={cn('flex min-w-0 flex-1 flex-col bg-muted/40', showRail && 'border-l border-border/70')}>
            <Command className="min-w-0 flex-1 rounded-none! bg-transparent p-0">
              {/* hairline-underlined search, no box */}
              <div className="px-2 pt-2">
                <div className="flex items-center gap-2 border-b border-border/70 pb-2 transition-colors focus-within:border-ring">
                  <Search className="size-4 shrink-0 text-muted-foreground opacity-70" />
                  <CommandPrimitive.Input
                    autoFocus
                    value={query}
                    onValueChange={setQuery}
                    placeholder="Search models..."
                    className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                </div>
              </div>
              <CommandList className="max-h-none min-h-0 flex-1 px-2 py-1.5">
                <CommandEmpty className="py-6 text-center text-xs text-muted-foreground">No models found</CommandEmpty>
                {visible.map((m) => {
                  const vendor = VENDOR_OF[m.provider]
                  const product = PRODUCT_LABEL[m.provider]
                  const name = displayModelName(m.label)
                  return (
                    <CommandItem
                      key={`${m.provider}:${m.value}`}
                      value={`${name} ${vendor.name} ${product} ${m.provider}:${m.value}`}
                      onSelect={() => pick(m.value)}
                      title={m.description}
                      className={cn(
                        // no checkmark — the selected row is marked by a background wash
                        'mb-0.5 rounded-md px-2 py-2 [&>svg:last-child]:hidden',
                        isSelected(m.value) && 'bg-foreground/[0.08]'
                      )}
                    >
                      <div className="min-w-0 flex-1 text-left">
                        <div className="truncate text-xs font-medium leading-snug">{name}</div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <BrandIcon svg={vendor.iconSvg} className="size-3 shrink-0 text-muted-foreground" />
                          <span className="truncate text-xs leading-snug font-normal text-muted-foreground/70">{product}</span>
                        </div>
                      </div>
                    </CommandItem>
                  )
                })}
              </CommandList>
            </Command>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
