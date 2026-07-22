import { useState } from 'react'
import anthropicIcon from '@resources/icons/anthropic.svg?raw'
import openaiIcon from '@resources/icons/openai.svg?raw'
import type { ProviderKind, Thread } from '@shared/domain'
import { useServer } from '../state/serverStore'
import { Check, ChevronDown, LayoutGrid, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'

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
  { id: 'openai', name: 'OpenAI', iconSvg: openaiIcon, colorCls: 'text-foreground', providers: ['codexAgent', 'codex'] }
]

const VENDOR_OF: Record<ProviderKind, Vendor> = {
  claude: VENDORS[0],
  codexAgent: VENDORS[1],
  codex: VENDORS[1]
}

/** product name shown under the model ("Claude", "Codex") */
const PRODUCT_LABEL: Record<ProviderKind, string> = {
  claude: 'Claude',
  codexAgent: 'Codex',
  codex: 'Codex API'
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* React 18 strips `ref` on plain function components, so render-merging the
          shadcn <Button> here breaks Base UI's trigger registration (popover would
          close immediately). Style the native trigger button instead. */}
      <PopoverTrigger
        className={cn(
          buttonVariants({ variant: 'ghost' }),
          'h-auto gap-[5px] rounded-lg border-border bg-muted px-2 py-1 text-[11.5px] font-normal text-muted-foreground hover:text-foreground/80 dark:bg-muted dark:hover:bg-accent'
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

      <PopoverContent align="start" side="top" sideOffset={8} className="w-[380px] gap-0 overflow-hidden p-0">
        <div className="flex">
          {/* vendor rail */}
          <div className="flex flex-col items-center gap-1 border-r p-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              title="All models"
              className={cn('text-muted-foreground', vendorFilter === 'all' && 'bg-muted text-foreground')}
              onClick={() => setVendorFilter('all')}
            >
              <LayoutGrid className="size-4" />
            </Button>
            {VENDORS.map((v) => (
              <Button
                key={v.id}
                variant="ghost"
                size="icon-sm"
                title={v.name}
                className={cn('text-muted-foreground', vendorFilter === v.id && 'bg-muted text-foreground', v.colorCls)}
                onClick={() => setVendorFilter(v.id)}
              >
                <BrandIcon svg={v.iconSvg} />
              </Button>
            ))}
          </div>

          {/* searchable model list */}
          <Command className="min-w-0 flex-1 rounded-none!">
            <CommandInput placeholder="Search models…" autoFocus />
            <CommandList className="max-h-72">
              <CommandEmpty className="text-[12.5px] text-muted-foreground">No models found.</CommandEmpty>
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
                    className="px-2 py-2"
                  >
                    <BrandIcon svg={vendor.iconSvg} className={cn('size-3.5', vendor.colorCls)} />
                    <span className="min-w-0 flex-1 truncate text-left text-xs leading-snug font-medium">
                      {name}
                    </span>
                    {isSelected(m.value) && <Check className="size-3.5 shrink-0 text-blue-400" />}
                  </CommandItem>
                )
              })}
            </CommandList>
          </Command>
        </div>
      </PopoverContent>
    </Popover>
  )
}
