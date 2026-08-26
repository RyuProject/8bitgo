export type SocialId = 'discord' | 'x' | 'youtube' | 'instagram' | 'facebook'

/** 线性风格的社交平台图标（简化绘制，继承 currentColor） */
export function SocialIcon({ id, size = 22 }: { id: SocialId; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }

  switch (id) {
    case 'discord':
      return (
        <svg {...common}>
          <path d="M8.7 5.2A15 15 0 0 1 12 4.8a15 15 0 0 1 3.3.4l.6 1.2a13 13 0 0 1 3.6 1.8c1.2 3.2 1.6 6.4 1.3 9.6a14 14 0 0 1-4.4 2.3l-.9-1.5c.6-.2 1.1-.4 1.6-.7l-.5-.4a10 10 0 0 1-9.2 0l-.5.4c.5.3 1 .5 1.6.7l-.9 1.5a14 14 0 0 1-4.4-2.3c-.3-3.2.1-6.4 1.3-9.6a13 13 0 0 1 3.6-1.8l.6-1.2z" />
          <circle cx="9.3" cy="12.6" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="14.7" cy="12.6" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'x':
      return (
        <svg {...common}>
          <path d="M4.5 4.5h4l11 15h-4z" />
          <path d="M19.5 4.5l-6.2 7M4.5 19.5l6.2-7" />
        </svg>
      )
    case 'youtube':
      return (
        <svg {...common}>
          <rect x="3" y="6" width="18" height="12" rx="4" />
          <path d="M10.2 9.6v4.8l4.3-2.4z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'instagram':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="4.5" />
          <circle cx="12" cy="12" r="3.6" />
          <circle cx="16.8" cy="7.2" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'facebook':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M13.4 20.5v-6.3h2.1l.4-2.6h-2.5v-1.7c0-.8.3-1.3 1.3-1.3h1.3V6.3a13 13 0 0 0-1.9-.1c-2 0-3.3 1.2-3.3 3.4v2H8.7v2.6h2.1v6.3" />
        </svg>
      )
  }
}
