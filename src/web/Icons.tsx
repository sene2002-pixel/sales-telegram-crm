import { ReactNode } from 'react';
const paths: Record<string, ReactNode> = {
  phone: (
    <>
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <path d="M10 18h4" />
    </>
  ),
  'chevron-right': <path d="m9 5 7 7-7 7" />,
  'chevron-left': <path d="m15 5-7 7 7 7" />,
  'chevron-down': <path d="m5 9 7 7 7-7" />,
  'chevron-up': <path d="m5 15 7-7 7 7" />,
  more: (
    <>
      <circle cx="4" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="20" cy="12" r="1" />
    </>
  ),
  layers: (
    <>
      <path d="m3 8 9-5 9 5-9 5zm0 5 9 5 9-5m-18 5 9 5 9-5" />
    </>
  ),
  send: <path d="m2 10 20-8-8 20-3-9zm9 3L22 2" />,
  home: (
    <>
      <path d="m3 10 9-7 9 7v11h-6v-7H9v7H3z" />
    </>
  ),
  clients: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6m1 5a5 5 0 0 1 3 5" />
    </>
  ),
  projects: (
    <>
      <rect x="3" y="7" width="18" height="14" rx="3" />
      <path d="M8 7V4h8v3M3 12h18m-11 0v3h4v-3" />
    </>
  ),
  tasks: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  analytics: <path d="M5 20v-8m7 8V4m7 16V8" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M7 3v4m10-4v4M3 10h18m-14 4h3m4 0h3m-10 4h3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  call: (
    <path d="M5 3h4l2 5-3 2a15 15 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A18 18 0 0 1 3 5a2 2 0 0 1 2-2Z" />
  ),
  email: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m3 6 9 7 9-7" />
    </>
  ),
  meeting: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3m3-12v6m-3-3h6" />
    </>
  ),
  reminder: (
    <>
      <path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6" />
    </>
  ),
  filter: (
    <>
      <path d="M3 7h18M3 17h18" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="17" r="2" />
    </>
  ),
  plus: <path d="M12 4v16M4 12h16" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  trash: (
    <>
      <path d="M3 6h18M8 6V3h8v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
    </>
  ),
  edit: (
    <>
      <path d="m4 16 12-12 4 4L8 20H4zm9-9 4 4" />
    </>
  ),
  file: (
    <>
      <path d="M5 3h9l5 5v13H5zm9 0v6h5M8 13h8m-8 4h6" />
    </>
  ),
  potential: (
    <>
      <path d="m3 8 9-5 9 5-9 5zm0 5 9 5 9-5m-18 5 9 5 9-5" />
    </>
  ),
  notes: (
    <>
      <path d="M8 16c0-3-3-4-3-8a7 7 0 0 1 14 0c0 4-3 5-3 8zM9 20h6m-5 3h4" />
    </>
  ),
  crown: <path d="m3 7 4 3 5-7 5 7 4-3-2 13H5z" />,
  sparkles: (
    <>
      <path d="m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3z" />
    </>
  ),
  factory: (
    <>
      <path d="M3 21V9l6 4V9l6 4V3h5v18zM7 17h1m4 0h1m4 0h1" />
    </>
  ),
  oil: (
    <>
      <path d="M12 2c-2 6-8 9-8 14a8 8 0 0 0 16 0c0-5-6-8-8-14Z" />
      <path d="M8 15a4 4 0 0 0 4 5" />
    </>
  ),
  heat: (
    <>
      <path d="M12 2c3 6 8 9 8 14a8 8 0 0 1-16 0c0-3 2-5 4-7 0 4 2 5 4 5z" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V3h12v18M16 9h4v12M8 7h4m-4 4h4m-4 4h4M2 21h20" />
    </>
  ),
  grid: (
    <>
      <path d="m8 3-5 18m13-18 5 18M7 6h10M5 12h14M3 18h18M12 3v18" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="3" width="16" height="7" rx="2" />
      <rect x="4" y="14" width="16" height="7" rx="2" />
      <path d="M8 6h1m3 0h4M8 17h1m3 0h4" />
    </>
  ),
  gear: (
    <>
      <path d="m10 3-1 3-3 1-3 3 2 2-1 4 3 2 3 3 2-2 4 1 2-3 3-3-2-2 1-4-3-2-3-3-2 2Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  cube: (
    <>
      <path d="m12 3 9 5v9l-9 5-9-5V8zm0 10v9M3 8l9 5 9-5m-14-7 9 5" />
    </>
  ),
  leaf: (
    <>
      <path d="M12 22V10m0 4C4 15 3 8 3 8c8-1 9 6 9 6zm0-4c0-7 9-7 9-7s1 7-9 7" />
    </>
  ),
  truck: (
    <>
      <path d="M2 5h12v12H2zm12 5h5l3 5v2h-8" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="19" r="2" />
    </>
  ),
  water: (
    <>
      <path d="M12 3c-2 4-5 6-5 9a5 5 0 0 0 10 0c0-3-3-5-5-9ZM2 21q3-4 6 0t6 0 6 0" />
    </>
  ),
  crane: (
    <>
      <path d="M5 22V3l15 3H5m10 0v9l-2 2M2 22h6" />
    </>
  ),
  plane: <path d="m12 2 2 7 7 5v3l-7-2v5l3 2H7l3-2v-5l-7 2v-3l7-5z" />,
  pill: (
    <>
      <path d="m5 13 8-8a5 5 0 0 1 7 7l-8 8a5 5 0 0 1-7-7zm4-4 7 7" />
    </>
  ),
  chip: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4" />
    </>
  ),
  ship: (
    <>
      <path d="M3 15 12 11l9 4-2 6H5zM6 13V7h12v6M9 7V4h6v3M2 23h20" />
    </>
  ),
  tool: <path d="M14 3a6 6 0 0 0-6 8l-6 6 5 5 6-6a6 6 0 0 0 8-6l-5 3-4-4z" />,
  cart: (
    <>
      <path d="M2 3h3l3 13h12l2-9H6" />
      <circle cx="10" cy="21" r="1" />
      <circle cx="19" cy="21" r="1" />
    </>
  ),
  funnel: <path d="M3 3h18l-7 9v8l-4 2V12z" />,
  helmet: (
    <>
      <path d="M3 17h18M5 17v-4a7 7 0 0 1 14 0v4M10 6V3h4v3M3 17v4h18v-4" />
    </>
  ),
  contact: (
    <>
      <circle cx="12" cy="7" r="4" />
      <path d="M4 22v-3a8 8 0 0 1 16 0v3" />
    </>
  ),
};
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.projects}
    </svg>
  );
}
export function IconBadge({
  name,
  color = 'blue',
  size = 20,
}: {
  name: string;
  color?: string;
  size?: number;
}) {
  return (
    <span className={`icon-badge badge-${color}`}>
      <Icon name={name} size={size} />
    </span>
  );
}
export function industryIcon(industry: string, segment = ''): [string, string] {
  const value = industry.toLowerCase();
  if (/нефт|газ|хим/.test(value)) return ['oil', 'red'];
  if (/металл|горно|руд/.test(value)) return ['building', 'blue'];
  if (/генерац|энергет|тэц|грэс/.test(value)) return ['factory', 'amber'];
  if (/сет|подстанц/.test(value)) return ['grid', 'teal'];
  if (/цод|телеком|майнинг/.test(value)) return ['server', 'purple'];
  if (/агро|ферм/.test(value)) return ['leaf', 'green'];
  if (/логист|ритейл|склад/.test(value)) return ['truck', 'orange'];
  if (/вод|жкх/.test(value)) return ['water', 'cyan'];
  if (/девелоп|строит/.test(value)) return ['crane', 'brown'];
  if (/транспорт|аэропорт/.test(value)) return ['plane', 'cyan'];
  if (/фарм/.test(value)) return ['pill', 'pink'];
  if (/электрон/.test(value)) return ['chip', 'purple'];
  if (/судо/.test(value)) return ['ship', 'teal'];
  if (/пищ|материал/.test(value)) return ['cube', 'pink'];
  if (segment === 'general_contractor') return ['helmet', 'slate'];
  if (segment === 'grid_company') return ['grid', 'teal'];
  if (segment === 'commercial') return ['cart', 'green'];
  if (segment === 'integrator') return ['server', 'blue'];
  if (segment === 'oem') return ['gear', 'purple'];
  if (segment === 'contractor') return ['tool', 'slate'];
  if (segment === 'design_institute') return ['edit', 'purple'];
  if (segment === 'shchitovik') return ['server', 'blue'];
  return ['building', 'blue'];
}
