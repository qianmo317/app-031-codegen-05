// 开料工单排产引擎（纯函数）：
// - 工步与刀路同源：trim/cut 工步的刀数直接取 SheetResult.steps，不许另估
// - 同规格板修边叠切算一次；内部刀路完全相同的板叠切算一次；同刀向 cut 连续排
// - 两台锯、按班次窗口落活；先插急件 / 按交期顺做 二选一
// - 时间：内部以整数分钟沿班次推进；加工时长按板数与刀数估时后向上取整到一刻钟；
//   换型等待为整数分钟（不取整）；对外完工时刻统一向上取整到一刻钟再与交期比较
// - 面积：平方毫米内部计算，展示折平方米（保留 2 位）
import type {
  Job,
  JobSchedule,
  SawMachine,
  ScheduleDiff,
  ScheduleOp,
  ScheduleParams,
  SchedulePolicy,
  ScheduleRow,
  ScheduleVersion,
  Shift,
  UnscheduledJob
} from '../types'
import { uid } from './format'

export const QUARTER_MIN = 15

export const DEFAULT_PARAMS: ScheduleParams = {
  horizonDays: 5,
  setup: { blade: 10, material: 20, thickness: 15 },
  cutSecondsPerBlade: 45, // 刀路里的每一刀（推台定位 + 下锯贯通）
  handleSecondsPerBoard: 90, // 每叠 1 张板的上料/对刀/卸料
  quarterMin: QUARTER_MIN,
  speedFactorBase: 1
}

export function defaultShifts(): Shift[] {
  return [{ id: 'shift_day', name: '白班', startMin: 8 * 60, endMin: 18 * 60, weekdays: [] }]
}

export function defaultMachines(): SawMachine[] {
  return [
    { id: 'saw_1', name: '1 号锯', speedFactor: 1, shiftIds: ['shift_day'] },
    { id: 'saw_2', name: '2 号锯', speedFactor: 1, shiftIds: ['shift_day'] }
  ]
}

export function ceilQuarter(min: number, step = QUARTER_MIN): number {
  return Math.max(step, Math.ceil(min / step) * step)
}

/** 平方毫米 → 平方米（展示精度：2 位小数）。 */
export function toM2(mm2: number): number {
  return Math.round((mm2 / 1_000_000) * 100) / 100
}

export function midnightOf(dateStr: string): number {
  return Math.floor(new Date(`${dateStr}T00:00:00`).getTime() / 60000)
}

export function todayStr(): string {
  const d = new Date()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 交期默认值：交期当日 18:00（下班点）。 */
export function dueAtFromDate(dateStr: string, hour = 18): number {
  return new Date(`${dateStr}T${`${hour}`.padStart(2, '0')}:00:00`).getTime()
}

/** 刀路指纹：排产工步所依据的每板刀序签名；刀路一改（重排/微调）就变。 */
export function cutFingerprint(job: Job): string {
  const r = job.result
  if (!r) return 'no-nest'
  const sig = r.sheets
    .map(
      (s) =>
        `${s.wMm}x${s.hMm}x${s.thicknessMm}:` +
        s.steps.map((st) => `${st.kind[0]}${st.axis}${st.order}`).join('/')
    )
    .join('|')
  return `fpc${r.sheets.length}:${sig}`
}

/** 单个活的排产输入签名：交期/急件标记 + 刀路指纹。 */
export function jobInputSignature(job: Job): string {
  return `${job.id}:${job.dueAt ?? 0}:${job.urgent ? 1 : 0}:${cutFingerprint(job)}`
}

// ── 工步推导（刀路同源）─────────────────────────────────────────────────────

interface TemplateOp {
  id: string
  kind: 'trim' | 'cut'
  jobId: string
  jobName: string
  boardDesc: string
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  stackSheets: number
  bladeCount: number // 直接来自刀路步骤数
  axis: 'v' | 'h'
  baseRawMin: number // 标准机速下未取整加工分钟
  source: ScheduleOp['source']
}

function sheetSpec(s: {
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
}): string {
  return `${s.wMm}x${s.hMm}x${s.thicknessMm}-${s.material}`
}

function boardDescOf(s: {
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
}): string {
  return `${s.wMm}×${s.hMm}×${s.thicknessMm} ${s.material}`
}

/**
 * 由排样刀路推出该单的工步模板（机台无关）：
 * 1. 同规格（宽×高×厚×材质）板的修边刀叠切，算 1 个 trim 工步，刀数取代表板修边刀数；
 * 2. 同规格且内部刀路（方向/坐标/区间/刀序）完全一致的板叠切，算 1 个 cut 工步；
 * 3. trim 全部在前（开料先修边），cut 按首刀方向排序（同刀向连续，减少换刀向）。
 */
export function buildJobOps(job: Job, params: ScheduleParams): TemplateOp[] {
  const r = job.result
  if (!r || r.sheets.length === 0) return []
  const sheets = r.sheets
  const ops: TemplateOp[] = []

  // ── 修边叠切：按板规格归组 ──
  const trimGroups = new Map<string, { s: (typeof sheets)[number]; indexes: number[] }>()
  for (const s of sheets) {
    const k = sheetSpec(s)
    const g = trimGroups.get(k)
    if (g) g.indexes.push(s.index)
    else trimGroups.set(k, { s, indexes: [s.index] })
  }
  const trimGroupList = [...trimGroups.entries()].sort(
    (a, b) => Math.min(...a[1].indexes) - Math.min(...b[1].indexes)
  )
  for (const [k, g] of trimGroupList) {
    const trims = g.s.steps.filter((st) => st.kind === 'trim')
    if (trims.length === 0) continue
    const orders = trims.map((t) => t.order)
    ops.push({
      id: `${job.id}:trim:${k}`,
      kind: 'trim',
      jobId: job.id,
      jobName: job.name,
      boardDesc: boardDescOf(g.s),
      wMm: g.s.wMm,
      hMm: g.s.hMm,
      thicknessMm: g.s.thicknessMm,
      material: g.s.material,
      stackSheets: g.indexes.length,
      bladeCount: trims.length,
      axis: trims[0].axis,
      baseRawMin:
        (trims.length * params.cutSecondsPerBlade +
          g.indexes.length * params.handleSecondsPerBoard) /
        60,
      source: g.indexes.map((si) => ({
        sheetIndex: si,
        orderFrom: Math.min(...orders),
        orderTo: Math.max(...orders),
        kind: 'trim' as const
      }))
    })
  }

  // ── 内部刀叠切：板规格 + 内部刀路签名归组 ──
  const cutSig = (s: (typeof sheets)[number]): string =>
    s.steps
      .filter((st) => st.kind === 'cut')
      .map((st) => `${st.axis}@${st.at}[${st.span[0]},${st.span[1]}]`)
      .join('/')
  const cutGroups = new Map<string, { s: (typeof sheets)[number]; indexes: number[] }>()
  for (const s of sheets) {
    if (s.steps.every((st) => st.kind === 'trim')) continue
    const key = `${sheetSpec(s)}#${cutSig(s)}`
    const g = cutGroups.get(key)
    if (g) g.indexes.push(s.index)
    else cutGroups.set(key, { s, indexes: [s.index] })
  }
  const cutOps: TemplateOp[] = []
  for (const [k, g] of cutGroups.entries()) {
    const internals = g.s.steps.filter((st) => st.kind === 'cut')
    const orders = internals.map((t) => t.order)
    cutOps.push({
      id: `${job.id}:cut:${k}`.slice(0, 200),
      kind: 'cut',
      jobId: job.id,
      jobName: job.name,
      boardDesc: boardDescOf(g.s),
      wMm: g.s.wMm,
      hMm: g.s.hMm,
      thicknessMm: g.s.thicknessMm,
      material: g.s.material,
      stackSheets: g.indexes.length,
      bladeCount: internals.length,
      axis: internals[0].axis,
      baseRawMin:
        (internals.length * params.cutSecondsPerBlade +
          g.indexes.length * params.handleSecondsPerBoard) /
        60,
      source: g.indexes.map((si) => ({
        sheetIndex: si,
        orderFrom: Math.min(...orders),
        orderTo: Math.max(...orders),
        kind: 'cut' as const
      }))
    })
  }
  // 同一刀向连着切：先按首刀方向（竖刀在前），同向后按首次出现顺序稳定
  cutOps.sort((a, b) => {
    if (a.axis !== b.axis) return a.axis === 'v' ? -1 : 1
    const af = Math.min(...a.source.map((x) => x.sheetIndex))
    const bf = Math.min(...b.source.map((x) => x.sheetIndex))
    return af - bf
  })

  return [...ops, ...cutOps]
}

// ── 班次窗口与落活 ──────────────────────────────────────────────────────────

interface TimeWindow {
  shiftId: string
  shiftName: string
  start: number
  end: number
}

interface MachineRuntime {
  machine: SawMachine
  windows: TimeWindow[]
  cursor: number
  last?: { material: string; thicknessMm: number; axis: 'v' | 'h' }
}

function shiftWindows(machine: SawMachine, shifts: Shift[], base: number, days: number): TimeWindow[] {
  const out: TimeWindow[] = []
  for (const sid of machine.shiftIds) {
    const sh = shifts.find((x) => x.id === sid)
    if (!sh) continue
    for (let d = 0; d < days; d++) {
      const start = base + d * 1440 + sh.startMin
      const end = base + d * 1440 + sh.endMin
      if (end <= start) continue
      if (sh.weekdays.length > 0) {
        const dow = new Date(start * 60000).getDay()
        if (!sh.weekdays.includes(dow)) continue
      }
      out.push({ shiftId: sh.id, shiftName: sh.name, start, end })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

interface PlaceResult {
  rows: ScheduleRow[]
  finish: number
  workMin: number
  setupMin: number
}

/**
 * 尝试把一整单（不可拆：同一单的所有工步必须在同一台机上顺序完成）落进该机班次。
 * 换刀向/换板种/换厚度的等待与加工必须落在同一个班次窗口内（工步不跨班拆）。
 */
function placeOnMachine(
  rt: MachineRuntime,
  ops: TemplateOp[],
  params: ScheduleParams,
  base: number
): PlaceResult | { tooLong: number } {
  const speed = rt.machine.speedFactor || 1
  let cursor = rt.cursor
  let last = rt.last
  const rows: ScheduleRow[] = []
  let workMin = 0
  let setupMinTotal = 0
  let maxNeeded = 0
  const dayOf = (abs: number): number => Math.floor(abs / 1440) - Math.floor(base / 1440)

  for (const op0 of ops) {
    const rawMin = op0.baseRawMin / speed
    const dur = ceilQuarter(rawMin, params.quarterMin)
    let setup = 0
    const reasons: string[] = []
    if (last) {
      if (last.axis !== op0.axis) {
        setup += params.setup.blade
        reasons.push('换刀向')
      }
      if (last.material !== op0.material) {
        setup += params.setup.material
        reasons.push('换板种')
      }
      if (last.thicknessMm !== op0.thicknessMm) {
        setup += params.setup.thickness
        reasons.push('换厚度')
      }
    }
    const need = setup + dur
    maxNeeded = Math.max(maxNeeded, need)
    const win = rt.windows.find((w) => w.end - Math.max(cursor, w.start) >= need)
    if (!win) return { tooLong: maxNeeded }
    const start = Math.max(cursor, win.start)

    const op = (kind: ScheduleOp['kind']): ScheduleOp => ({
      id: op0.id,
      kind,
      jobId: op0.jobId,
      jobName: op0.jobName,
      boardDesc: op0.boardDesc,
      wMm: op0.wMm,
      hMm: op0.hMm,
      thicknessMm: op0.thicknessMm,
      material: op0.material,
      stackSheets: op0.stackSheets,
      bladeCount: kind === 'setup' ? 0 : op0.bladeCount,
      axis: kind === 'setup' ? null : op0.axis,
      rawMin: kind === 'setup' ? 0 : Math.round(rawMin * 10) / 10,
      workMin: kind === 'setup' ? 0 : dur,
      setupMin: kind === 'setup' ? setup : setup,
      source: kind === 'setup' ? [] : op0.source
    })

    if (setup > 0) {
      rows.push({
        rowId: `${op0.id}:setup`,
        machineId: rt.machine.id,
        machineName: rt.machine.name,
        shiftId: win.shiftId,
        shiftName: win.shiftName,
        dayIndex: dayOf(win.start),
        op: op('setup'),
        startMin: start,
        endMin: start + setup,
        setupFromRowId: rows.length ? rows[rows.length - 1].rowId : undefined,
        reasons
      })
    }
    rows.push({
      rowId: op0.id,
      machineId: rt.machine.id,
      machineName: rt.machine.name,
      shiftId: win.shiftId,
      shiftName: win.shiftName,
      dayIndex: dayOf(win.start),
      op: op(op0.kind),
      startMin: start + setup,
      endMin: start + setup + dur
    })
    cursor = start + need
    last = { material: op0.material, thicknessMm: op0.thicknessMm, axis: op0.axis }
    workMin += dur
    setupMinTotal += setup
  }

  return { rows, finish: cursor, workMin, setupMin: setupMinTotal }
}

// ── 队列排序（两条策略只能选一条）──────────────────────────────────────────

export function queueJobs(jobs: Job[], policy: SchedulePolicy): Job[] {
  const due = (j: Job): number => (j.dueAt ? j.dueAt / 60000 : Number.MAX_SAFE_INTEGER)
  const byDue = (a: Job, b: Job): number => due(a) - due(b) || a.name.localeCompare(b.name, 'zh')
  if (policy === 'urgent-first') {
    return [...jobs].sort((a, b) => {
      const ua = a.urgent ? 1 : 0
      const ub = b.urgent ? 1 : 0
      if (ua !== ub) return ub - ua // 急件整单插到队首
      return byDue(a, b)
    })
  }
  return [...jobs].sort(byDue)
}

export function policyDescription(policy: SchedulePolicy): string {
  return policy === 'urgent-first'
    ? '先插急件：急件不管交期先后，整单插到队首最先上锯。好处是最要紧的单能赶出来；代价是后面的单被顺延，原本赶得上交期的单可能被推到赶不上。'
    : '按交期顺做：严格按交期从紧到松顺着排，整体最稳、变动最小。代价是急件只能在队列里等，最要紧的那一单即使插了急件标记也可能压线交付。'
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

export interface ScheduleInput {
  jobs: Job[]
  machines: SawMachine[]
  shifts: Shift[]
  params: ScheduleParams
  policy: SchedulePolicy
  horizonStartDate: string
}

export function runSchedule(input: ScheduleInput): ScheduleVersion {
  const { jobs, machines, shifts, params, policy, horizonStartDate } = input
  const base = midnightOf(horizonStartDate)

  // 1) 先把根本进不了队列的单分出来
  const unscheduled: UnscheduledJob[] = []
  const ready: Job[] = []
  for (const j of jobs) {
    if (!j.result || j.result.sheets.length === 0) {
      unscheduled.push({
        jobId: j.id,
        jobName: j.name,
        reason: '还没排样',
        detail: '该单没有排样结果，排产工步无刀路可取；先到排样页算出摆法与刀路。'
      })
      continue
    }
    if (j.result.unplaced.length > 0) {
      unscheduled.push({
        jobId: j.id,
        jobName: j.name,
        reason: '排样有未排下零件',
        detail: `排样结果里还有 ${j.result.unplaced.length} 种零件没排下，刀路不完整，不能进排产。`
      })
      continue
    }
    ready.push(j)
  }

  const makeRuntimes = (days: number): MachineRuntime[] =>
    machines.map((m) => ({ machine: m, windows: shiftWindows(m, shifts, base, days), cursor: base }))
  const runtimes = makeRuntimes(params.horizonDays)
  const extRuntimes = makeRuntimes(params.horizonDays + 14)
  const longestShift = Math.max(0, ...runtimes.flatMap((rt) => rt.windows.map((w) => w.end - w.start)))
  const maxSpeed = Math.max(1, ...machines.map((m) => m.speedFactor || 1))

  const jobSchedules: JobSchedule[] = []
  const allRows: ScheduleRow[] = []
  let totalAreaMm2 = 0

  for (const job of queueJobs(ready, policy)) {
    const ops = buildJobOps(job, params)
    let best: { rtIndex: number; res: PlaceResult } | null = null
    runtimes.forEach((rt, i) => {
      const res = placeOnMachine(rt, ops, params, base)
      if ('rows' in res && (!best || res.finish < best.res.finish)) best = { rtIndex: i, res }
    })

    if (!best) {
      const noShift = runtimes.every((rt) => rt.windows.length === 0)
      const longestOp = Math.max(
        ...ops.map((op) => ceilQuarter(op.baseRawMin / maxSpeed, params.quarterMin))
      )
      let reason: string
      let detail: string
      if (noShift) {
        reason = '两台机都没有可用班次'
        detail = `排产天数 ${params.horizonDays} 天内两台锯都没开通任何班次；先在排产设置里给机台加班次。`
      } else if (longestOp > longestShift) {
        reason = '单个工步一个班次做不完'
        detail = `该单最长工步需 ${longestOp} 分钟（已向上取整一刻钟），两台机最长班次只有 ${longestShift} 分钟；工步不可跨班拆分，请加长班次或提高机台速度。`
      } else {
        let earliest: number | null = null
        extRuntimes.forEach((rt) => {
          const res = placeOnMachine(rt, ops, params, base)
          if ('rows' in res)
            earliest = earliest === null ? res.finish : Math.min(earliest, res.finish)
        })
        reason = '两台机在排产天数内都满班'
        detail =
          earliest !== null
            ? `未来 ${params.horizonDays} 天两台锯的班次都排满，该单挤不进来；按现配置最早约 ${fmtClock(earliest)} 才能完工，超出排产上限。可加班次、加长排产天数或换先插急件策略。`
            : `未来 ${params.horizonDays} 天两台锯班次排满，再放宽 14 天仍排不下，请加班次。`
      }
      unscheduled.push({ jobId: job.id, jobName: job.name, reason, detail })
      continue
    }

    const { rtIndex, res } = best as { rtIndex: number; res: PlaceResult }
    const rt = runtimes[rtIndex]
    rt.cursor = res.finish
    const lastWorkRow = [...res.rows].reverse().find((x) => x.op.kind !== 'setup')
    if (lastWorkRow) {
      rt.last = {
        material: lastWorkRow.op.material,
        thicknessMm: lastWorkRow.op.thicknessMm,
        axis: lastWorkRow.op.axis ?? 'h'
      }
    }
    // 同步放宽窗口的诊断 runtime（该单占的是 best 机台，保证 earliest 估算有序）
    extRuntimes[rtIndex].cursor = res.finish
    extRuntimes[rtIndex].last = rt.last

    allRows.push(...res.rows)
    const dueMin = job.dueAt ? Math.floor(job.dueAt / 60000) : null
    const finishQuarter = ceilQuarter(res.finish, params.quarterMin)
    const lateMin = dueMin === null ? 0 : finishQuarter - dueMin
    const areaMm2 = job.result!.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
    totalAreaMm2 += areaMm2
    jobSchedules.push({
      jobId: job.id,
      jobName: job.name,
      machineId: rt.machine.id,
      machineName: rt.machine.name,
      startMin: res.rows[0].startMin,
      endMin: res.finish,
      finishQuarterMin: finishQuarter,
      dueAt: job.dueAt ?? null,
      lateMin,
      late: lateMin > 0,
      areaMm2,
      opCount: res.rows.filter((x) => x.op.kind !== 'setup').length,
      workMin: res.workMin,
      setupMin: res.setupMin,
      rows: res.rows
    })
  }

  allRows.sort((a, b) => a.startMin - b.startMin || a.machineId.localeCompare(b.machineId))
  const lateJobIds = jobSchedules.filter((j) => j.late).map((j) => j.jobId)
  const urgentNames = ready.filter((j) => j.urgent).map((j) => j.name)
  const lateNames = jobSchedules.filter((j) => j.late).map((j) => j.jobName)
  const notes =
    policy === 'urgent-first'
      ? `本版采用「先插急件」。${
          urgentNames.length ? `急件 ${urgentNames.join('、')} 插队最先上锯；` : '当前没有标记急件的单；'
        }代价是队列后段被顺延${
          lateNames.length ? `，${lateNames.join('、')} 将赶不上交期` : '，本版暂无单被推过交期'
        }。改走「按交期顺做」整体更稳，但急件响应变慢。`
      : `本版采用「按交期顺做」。整体顺序按交期从紧到松、变动最小；代价是急件只能排队等${
          urgentNames.length ? `（急件：${urgentNames.join('、')}）` : ''
        }，最要紧的单可能压线${
          lateNames.length ? `；${lateNames.join('、')} 将赶不上交期` : '，本版全部赶得上'
        }。改走「先插急件」可抢救件，但后段单可能被推晚。`

  return {
    id: uid('sch'),
    createdAt: Date.now(),
    policy,
    horizonStartMin: base,
    horizonStartDate,
    machines: JSON.parse(JSON.stringify(machines)),
    shifts: JSON.parse(JSON.stringify(shifts)),
    params: JSON.parse(JSON.stringify(params)),
    rows: allRows,
    jobs: jobSchedules,
    unscheduled,
    lateJobIds,
    totalAreaMm2,
    notes,
    status: 'draft',
    exported: false,
    fingerprint: fingerprintOf({ jobs: ready, machines, shifts, params, policy, horizonStartDate }),
    jobInputFp: Object.fromEntries(ready.map((j) => [j.id, jobInputSignature(j)]))
  }
}

/** 输入指纹：活（含刀路指纹/交期/急件）+ 机台速度 + 班次 + 参数 + 策略 + 起始日。 */
export function fingerprintOf(input: ScheduleInput): string {
  const jobsSig = input.jobs.map((j) => jobInputSignature(j)).sort().join('||')
  const machSig = input.machines
    .map((m) => `${m.id}:${m.name}:${m.speedFactor}:${[...m.shiftIds].sort().join(',')}`)
    .join('||')
  const shiftSig = input.shifts
    .map((s) => `${s.id}:${s.name}:${s.startMin}-${s.endMin}:${[...s.weekdays].sort().join('.')}`)
    .join('||')
  return [jobsSig, machSig, shiftSig, JSON.stringify(input.params), input.policy, input.horizonStartDate].join('##')
}

// ── 版本 diff（改速/加班次重排后逐单点名）──────────────────────────────────

export function diffVersions(prev: ScheduleVersion | undefined, next: ScheduleVersion): ScheduleDiff {
  const d: ScheduleDiff = {
    hasPrevious: !!prev,
    machineChanged: [],
    finishChanged: [],
    rowsChanged: 0,
    rowsAdded: 0,
    rowsRemoved: 0,
    newLate: [],
    rescued: [],
    prevVersionId: prev?.id
  }
  if (!prev) return d
  const pj = new Map(prev.jobs.map((j) => [j.jobId, j]))
  for (const nj of next.jobs) {
    const p = pj.get(nj.jobId)
    if (!p) continue
    if (p.machineId !== nj.machineId)
      d.machineChanged.push({ jobId: nj.jobId, jobName: nj.jobName, from: p.machineName, to: nj.machineName })
    if (p.finishQuarterMin !== nj.finishQuarterMin)
      d.finishChanged.push({
        jobId: nj.jobId,
        jobName: nj.jobName,
        fromMin: p.finishQuarterMin,
        toMin: nj.finishQuarterMin
      })
    if (!p.late && nj.late) d.newLate.push({ jobId: nj.jobId, jobName: nj.jobName })
    if (p.late && !nj.late) d.rescued.push({ jobId: nj.jobId, jobName: nj.jobName })
  }
  const pr = new Map(prev.rows.map((r) => [r.rowId, r]))
  const nr = new Set(next.rows.map((r) => r.rowId))
  for (const r of next.rows) {
    const p = pr.get(r.rowId)
    if (!p) {
      d.rowsAdded++
      continue
    }
    if (
      p.machineId !== r.machineId ||
      p.shiftId !== r.shiftId ||
      p.startMin !== r.startMin ||
      p.endMin !== r.endMin
    ) {
      d.rowsChanged++
      r.changed = true
    }
  }
  for (const id of pr.keys()) if (!nr.has(id)) d.rowsRemoved++
  for (const j of next.jobs) {
    if (
      d.machineChanged.some((x) => x.jobId === j.jobId) ||
      d.finishChanged.some((x) => x.jobId === j.jobId)
    )
      j.changed = true
  }
  return d
}

// ── 展示与导出 ──────────────────────────────────────────────────────────────

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

/** 绝对分钟（分钟时间戳）→ 'MM-DD(周X) HH:mm'。 */
export function fmtClock(absMin: number): string {
  const d = new Date(absMin * 60000)
  const mm = `${d.getMonth() + 1}`.padStart(2, '0')
  const dd = `${d.getDate()}`.padStart(2, '0')
  const hh = `${d.getHours()}`.padStart(2, '0')
  const mi = `${d.getMinutes()}`.padStart(2, '0')
  return `${mm}-${dd}(周${WEEK[d.getDay()]}) ${hh}:${mi}`
}

export function fmtDur(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`
}

export function fmtDue(ts: number | null | undefined): string {
  if (!ts) return '无交期'
  const d = new Date(ts)
  const mm = `${d.getMonth() + 1}`.padStart(2, '0')
  const dd = `${d.getDate()}`.padStart(2, '0')
  const hh = `${d.getHours()}`.padStart(2, '0')
  const mi = `${d.getMinutes()}`.padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 排产表 CSV（导出的单据与页面/打印同源：同一个 ScheduleVersion）。 */
export function scheduleToCsv(v: ScheduleVersion): string {
  const lines: string[] = []
  lines.push(`开料工单排产表（导出时间 ${new Date().toLocaleString('zh-CN')}）`)
  lines.push(
    [
      '策略',
      v.policy === 'urgent-first' ? '先插急件' : '按交期顺做',
      '排产起始',
      v.horizonStartDate,
      '版本',
      v.id.slice(-6),
      '状态',
      v.status === 'voided' ? '已作废' : v.exported ? '已发出' : '本机存档'
    ]
      .map(csvCell)
      .join(',')
  )
  lines.push(['说明', v.notes].map(csvCell).join(','))
  lines.push('')
  lines.push(
    [
      '日期序',
      '机台',
      '班次',
      '开始',
      '结束',
      '时长(分钟)',
      '项目',
      '工步',
      '板规格',
      '叠切张数',
      '刀数(取自刀路)',
      '刀向',
      '换型等待(分钟)',
      '刀路出处'
    ].join(',')
  )
  for (const r of v.rows) {
    const op = r.op
    lines.push(
      [
        `第${r.dayIndex + 1}天`,
        r.machineName,
        r.shiftName,
        fmtClock(r.startMin),
        fmtClock(r.endMin),
        op.kind === 'setup' ? r.endMin - r.startMin : op.workMin,
        op.jobName,
        op.kind === 'trim' ? '修边叠切' : op.kind === 'cut' ? '内部刀裁切' : '换型等待',
        op.boardDesc,
        op.stackSheets,
        op.bladeCount,
        op.axis === 'v' ? '竖刀' : op.axis === 'h' ? '横刀' : '—',
        op.kind === 'setup' ? r.endMin - r.startMin : 0,
        op.source.length
          ? op.source
              .map(
                (s) =>
                  `板${s.sheetIndex + 1}刀序${s.orderFrom + 1}${s.orderTo > s.orderFrom ? `~${s.orderTo + 1}` : ''}`
              )
              .join('；')
          : ''
      ]
        .map(csvCell)
        .join(',')
    )
  }
  lines.push('')
  lines.push('项目,机台,完工时刻(一刻钟口径),交期,状态,加工(分钟),等待(分钟),加工面积(m²)')
  for (const j of v.jobs) {
    lines.push(
      [
        j.jobName,
        j.machineName,
        fmtClock(j.finishQuarterMin),
        fmtDue(j.dueAt),
        j.late ? `赶不上（晚 ${j.lateMin} 分钟）` : '赶得上',
        j.workMin,
        j.setupMin,
        toM2(j.areaMm2).toFixed(2)
      ]
        .map(csvCell)
        .join(',')
    )
  }
  for (const u of v.unscheduled) {
    lines.push(['', u.jobName, '未排进', u.reason, u.detail].map(csvCell).join(','))
  }
  return '﻿' + lines.join('\n')
}
