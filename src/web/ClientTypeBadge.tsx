import { primarySegments } from '../shared/contracts';
import { Icon, industryIcon } from './Icons';
import type { ReactNode } from 'react';

const types = {
  holding: {
    color: '#6b78e8',
    background: '#eceefd',
    glyph: (
      <path d="M3 21V9.5A1.5 1.5 0 0 1 4.5 8H9M9 21V4.5A1.5 1.5 0 0 1 10.5 3h4A1.5 1.5 0 0 1 16 4.5V21M16 11h3.5a1.5 1.5 0 0 1 1.5 1.5V21M2 21h20M12 7.5h1M12 11.5h1M12 15.5h1" />
    ),
  },
  end_client: {
    color: '#1f7aea',
    background: '#e4effd',
    glyph: (
      <path d="M4 21V4.5A1.5 1.5 0 0 1 5.5 3h7A1.5 1.5 0 0 1 14 4.5V21M14 10h4.5a1.5 1.5 0 0 1 1.5 1.5V21M3 21h18M7.5 7h3M7.5 11h3M7.5 15h3" />
    ),
  },
  contractor: {
    color: '#a8692e',
    background: '#f6ede3',
    glyph: (
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    ),
  },
  integrator: {
    color: '#13849b',
    background: '#e2f4f8',
    glyph: (
      <>
        <rect x="4.5" y="3" width="15" height="18" rx="1.5" />
        <path d="M12 3v18M9.5 11v2.5M14.5 11v2.5M7 6.5h2.5M14.5 6.5H17" />
      </>
    ),
  },
  grid_company: {
    color: '#b07a00',
    background: '#fff3d9',
    glyph: <path d="M13.5 2.5L5 13.5h6.2l-1.2 8 8.5-11.2h-6.3z" />,
  },
  oem: {
    color: '#5b6b8c',
    background: '#edf0f5',
    glyph: (
      <g transform="translate(12 12) scale(.88) translate(-12 -12)">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </g>
    ),
  },
  distributor: {
    color: '#178a55',
    background: '#e3f5ec',
    glyph: (
      <>
        <g transform="translate(2 2) scale(.8) translate(-2 -2)" strokeWidth="2.4">
          <path d="M4.5 3.5h15l2 5.5h-19z" />
          <path d="M8.5 3.5L7.5 9M12 3.5V9M15.5 3.5l1 5.5" />
          <path d="M4 9v11.5h16V9" />
          <path d="M7.5 20.5V15h4v5.5" />
        </g>
        <circle cx="17" cy="17" r="7.3" fill="#E3F5EC" stroke="none" />
        <circle cx="17" cy="17" r="5.8" />
        <path d="M15.9 20.4V13.9h2.2a1.7 1.7 0 0 1 0 3.4h-3.3M14.8 18.9h3.3" strokeWidth="1.7" />
      </>
    ),
  },
  design_institute: {
    color: '#c74c86',
    background: '#fbe8f1',
    glyph: (
      <>
        <path d="M14.5 2.5h-8A1.5 1.5 0 0 0 5 4v16a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 20V7z" />
        <path d="M14.5 2.5V7H19" />
        <path d="M8.5 11h7M8.5 14.5h7M8.5 18h4" />
      </>
    ),
  },
} satisfies Record<
  (typeof primarySegments)[number],
  { color: string; background: string; glyph: ReactNode }
>;

export function ClientTypeBadge({
  segment = '',
  industry = '',
  large = false,
}: {
  segment?: string;
  industry?: string;
  large?: boolean;
}) {
  const size = large ? 21 : 16;
  const className = 'icon-badge pico-client-type-badge' + (large ? ' is-large' : '');
  if (!Object.hasOwn(types, segment)) {
    const [name, color] = industryIcon(industry, segment);
    return (
      <span className={className + ' badge-' + color}>
        <Icon name={name} size={size} />
      </span>
    );
  }
  const type = types[segment as keyof typeof types];
  return (
    <span
      className={className}
      data-client-type={segment}
      style={{ color: type.color, backgroundColor: type.background }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={large ? 1.9 : 2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {type.glyph}
      </svg>
    </span>
  );
}
