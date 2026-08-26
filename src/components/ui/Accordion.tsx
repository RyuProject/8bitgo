import { useState } from 'react'
import { cx } from '@/lib/format'

export interface AccordionItem {
  q: string
  a: string
}

export function Accordion({ items, defaultOpen = 0 }: { items: AccordionItem[]; defaultOpen?: number }) {
  const [open, setOpen] = useState<number | null>(defaultOpen)

  return (
    <div className="divide-y divide-line rounded-2xl border border-line bg-surface">
      {items.map((item, i) => {
        const isOpen = open === i
        return (
          <div key={item.q}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : i)}
              className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-black/[0.03]"
            >
              <span className="font-semibold">{item.q}</span>
              <span
                aria-hidden
                className={cx(
                  'grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line-strong text-muted transition',
                  isOpen && 'rotate-45 border-brand text-brand-hover',
                )}
              >
                +
              </span>
            </button>
            <div
              className={cx(
                'grid transition-[grid-template-rows] duration-300 ease-out',
                isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
              )}
            >
              <div className="overflow-hidden">
                <p className="px-5 pb-5 text-sm leading-relaxed text-muted">{item.a}</p>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
