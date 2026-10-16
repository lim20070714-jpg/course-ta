/** 预置实验的简化电路图（IEC 符号）。数值由滑块驱动，图中只画拓扑与元件名。 */

const STROKE = '#3a4254'
const LABEL = '#5a6274'

function Wire({ d }: { d: string }) {
  return <path d={d} fill="none" stroke={STROKE} strokeWidth={1.6} />
}

function NodeDot({ x, y }: { x: number; y: number }) {
  return <circle cx={x} cy={y} r={3} fill={STROKE} />
}

function Lbl({
  x,
  y,
  text,
  anchor = 'middle',
}: {
  x: number
  y: number
  text: string
  anchor?: 'start' | 'middle' | 'end'
}) {
  return (
    <text x={x} y={y} fontSize={12} fill={LABEL} textAnchor={anchor}>
      {text}
    </text>
  )
}

function RBoxV({ x, y0, y1, label }: { x: number; y0: number; y1: number; label: string }) {
  return (
    <g>
      <rect
        x={x - 8}
        y={y0}
        width={16}
        height={y1 - y0}
        fill="#fff"
        stroke={STROKE}
        strokeWidth={1.6}
      />
      <Lbl x={x + 14} y={(y0 + y1) / 2 + 4} text={label} anchor="start" />
    </g>
  )
}

function IndV({ x, y0, y1, label }: { x: number; y0: number; y1: number; label: string }) {
  return (
    <g>
      <rect x={x - 8} y={y0} width={16} height={y1 - y0} fill={STROKE} />
      <Lbl x={x + 14} y={(y0 + y1) / 2 + 4} text={label} anchor="start" />
    </g>
  )
}

function RBoxH({ x0, x1, y, label }: { x0: number; x1: number; y: number; label: string }) {
  return (
    <g>
      <rect x={x0} y={y - 8} width={x1 - x0} height={16} fill="#fff" stroke={STROKE} strokeWidth={1.6} />
      <Lbl x={(x0 + x1) / 2} y={y - 14} text={label} />
    </g>
  )
}

function IndH({ x0, x1, y, label }: { x0: number; x1: number; y: number; label: string }) {
  return (
    <g>
      <rect x={x0} y={y - 8} width={x1 - x0} height={16} fill={STROKE} />
      <Lbl x={(x0 + x1) / 2} y={y - 14} text={label} />
    </g>
  )
}

function CapV({
  x,
  y,
  label,
  side = 'right',
}: {
  x: number
  y: number
  label: string
  side?: 'left' | 'right'
}) {
  return (
    <g>
      <line x1={x - 13} y1={y - 4} x2={x + 13} y2={y - 4} stroke={STROKE} strokeWidth={2} />
      <line x1={x - 13} y1={y + 4} x2={x + 13} y2={y + 4} stroke={STROKE} strokeWidth={2} />
      <Lbl
        x={side === 'right' ? x + 20 : x - 20}
        y={y + 5}
        text={label}
        anchor={side === 'right' ? 'start' : 'end'}
      />
    </g>
  )
}

function VSource({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={13} fill="#fff" stroke={STROKE} strokeWidth={1.6} />
      <line x1={x - 5} y1={y - 4} x2={x + 5} y2={y - 4} stroke={STROKE} strokeWidth={1.6} />
      <line x1={x} y1={y - 9} x2={x} y2={y + 1} stroke={STROKE} strokeWidth={1.6} />
      <line x1={x - 5} y1={y + 7} x2={x + 5} y2={y + 7} stroke={STROKE} strokeWidth={1.6} />
      <Lbl x={x - 20} y={y + 5} text={label} anchor="end" />
    </g>
  )
}

function Ground({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <line x1={x - 14} y1={y} x2={x + 14} y2={y} stroke={STROKE} strokeWidth={1.8} />
      <line x1={x - 9} y1={y + 6} x2={x + 9} y2={y + 6} stroke={STROKE} strokeWidth={1.6} />
      <line x1={x - 4} y1={y + 12} x2={x + 4} y2={y + 12} stroke={STROKE} strokeWidth={1.4} />
    </g>
  )
}

function OpAmp({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <g>
      <path
        d={`M${x} ${y - 14} L${x + 26} ${y} L${x} ${y + 14} Z`}
        fill="#fff"
        stroke={STROKE}
        strokeWidth={1.6}
      />
      <line x1={x + 1} y1={y - 6} x2={x + 11} y2={y - 6} stroke={STROKE} strokeWidth={1.6} />
      <line x1={x + 1} y1={y + 6} x2={x + 11} y2={y + 6} stroke={STROKE} strokeWidth={1.6} />
      <text x={x + 2} y={y - 1} fontSize={10} fill={LABEL}>
        +
      </text>
      <text x={x + 2} y={y + 12} fontSize={10} fill={LABEL}>
        −
      </text>
      <Lbl x={x + 13} y={y + 26} text={label} />
    </g>
  )
}

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 280 185" style={{ width: '100%', maxWidth: 330 }}>
      {children}
    </svg>
  )
}

function DividerSchematic() {
  return (
    <Svg>
      <Wire d="M60 72 L60 34 L160 34 L160 44" />
      <Wire d="M60 98 L60 146 L160 146 L160 132" />
      <Wire d="M160 76 L160 100" />
      <Wire d="M160 92 L224 92" />
      <VSource x={60} y={85} label="V₁" />
      <RBoxV x={160} y0={44} y1={76} label="R₁" />
      <RBoxV x={160} y0={100} y1={132} label="R₂" />
      <NodeDot x={160} y={92} />
      <NodeDot x={224} y={92} />
      <Lbl x={224} y={82} text="v_out" />
      <Ground x={160} y={146} />
    </Svg>
  )
}

function RcSchematic() {
  return (
    <Svg>
      <Wire d="M60 72 L60 34 L160 34 L160 44" />
      <Wire d="M60 98 L60 146 L160 146" />
      <Wire d="M160 76 L160 98" />
      <Wire d="M160 106 L160 146" />
      <Wire d="M160 92 L224 92" />
      <VSource x={60} y={85} label="V₁" />
      <RBoxV x={160} y0={44} y1={76} label="R₁" />
      <CapV x={160} y={102} label="C₁" />
      <NodeDot x={160} y={92} />
      <NodeDot x={224} y={92} />
      <Lbl x={224} y={82} text="v_C" />
      <Ground x={160} y={146} />
    </Svg>
  )
}

function RlSchematic() {
  return (
    <Svg>
      <Wire d="M60 72 L60 34 L160 34 L160 44" />
      <Wire d="M60 98 L60 146 L160 146 L160 132" />
      <Wire d="M160 76 L160 100" />
      <VSource x={60} y={85} label="V₁" />
      <RBoxV x={160} y0={44} y1={76} label="R₁" />
      <IndV x={160} y0={100} y1={132} label="L₁" />
      <Ground x={160} y={146} />
    </Svg>
  )
}

function RlcSchematic() {
  return (
    <Svg>
      <Wire d="M50 72 L50 40 L240 40" />
      <Wire d="M50 98 L50 150 L240 150" />
      <Wire d="M240 40 L240 88" />
      <Wire d="M240 96 L240 150" />
      <Wire d="M240 40 L266 40" />
      <VSource x={50} y={85} label="V₁" />
      <RBoxH x0={82} x1={122} y={40} label="R₁" />
      <IndH x0={152} x1={192} y={40} label="L₁" />
      <CapV x={240} y={92} label="C₁" side="left" />
      <NodeDot x={240} y={40} />
      <NodeDot x={266} y={40} />
      <Lbl x={266} y={30} text="v_C" anchor="end" />
      <Ground x={145} y={150} />
    </Svg>
  )
}

function SallenSchematic() {
  return (
    <Svg>
      <Wire d="M56 72 L56 34 L92 34" />
      <Wire d="M56 109 L56 148" />
      <VSource x={56} y={96} label="V₁" />
      <Ground x={56} y={148} />
      <RBoxH x0={92} x1={128} y={34} label="R₁" />
      <Wire d="M128 34 L160 34" />
      <NodeDot x={144} y={34} />
      <RBoxH x0={160} x1={196} y={34} label="R₂" />
      <Wire d="M196 34 L230 34" />
      <NodeDot x={208} y={34} />
      <Wire d="M144 34 L144 62" />
      <CapV x={144} y={68} label="C₁" side="left" />
      <Wire d="M144 74 L144 128 L268 128 L268 40" />
      <Wire d="M208 34 L208 62" />
      <CapV x={208} y={68} label="C₂" side="right" />
      <Wire d="M208 74 L208 100" />
      <Ground x={208} y={100} />
      <OpAmp x={230} y={40} label="U₁" />
      <Wire d="M241 46 L256 46 L256 66 L268 66" />
      <Wire d="M256 40 L276 40" />
      <NodeDot x={268} y={40} />
      <NodeDot x={268} y={66} />
      <Lbl x={276} y={28} text="v_out" anchor="end" />
    </Svg>
  )
}

export default function Schematic({ labId }: { labId: string }) {
  if (labId === 'divider') return <DividerSchematic />
  if (labId === 'rc' || labId === 'rc-lowpass' || labId === 'square-rc') return <RcSchematic />
  if (labId === 'rl') return <RlSchematic />
  if (labId === 'rlc' || labId === 'rlc-step') return <RlcSchematic />
  if (labId === 'sallen-key') return <SallenSchematic />
  return null
}
