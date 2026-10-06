// 开料工单排产 · 纯计算层（不碰界面状态，状态见 scheduleStore.ts）
//
// 同源原则：每个活的工步（刀数 / 刀向 / 贯通长度）直接取自裁切步骤 sheet.steps，
// 经 cuts.ts 的 buildSawWorkSteps 叠切聚合 —— 裁切步骤怎么走、有几刀，排产就按那几刀算，
// 不另估一套数。完工时刻、超期判定全由本文件算出，开料工单页 / 项目列表页 / 导出单据
// 三处消费同一份结果。
//
// 单位与精度约定（界面与导出单据同样照此）：
//   · 时间：内部一律按「分钟」计（自开工日 00:00 起的绝对分钟，可跨天）；
//     每个工单的机台占用块（机台等待 + 加工）向上取整到一刻钟（15 分钟）后占用机台；
//     时刻显示 HH:MM（班次边界按所设时刻，本身不一定落在刻上）。
//   · 面积：按平方毫米（mm²）累计，展示折算平方米（m²）保留 2 位小数（format.ts areaM2）。
//   · 锯速 mm/min、各类等待分钟均为整数参数；搬板对位分钟允许 1 位小数。
//
// 排产规则：按交期升序（交期早的先上机，未设交期的排最后）贪心派工；
// 每个活放到「完工最早」的机台与班次；活不可跨班次，排产期内排不下则点名原因。
// 策略二选一（互斥）：
//   due  —— 按交期顺着做：整体稳，急件在队列里等，最要紧的一单可能压线；
//   rush —— 先插急件：最要紧的单先赶出来，代价是后面几单被推晚，可能由赶上变赶不上。
import type { Job } from '../types'
import { buildSawWorkSteps, type SawWorkStep } from './cuts'

export type ScheduleStrategy = 'due' | 'rush'

export const QUARTER_MIN = 15 // 一刻钟
export const DAY_MIN = 1440

export interface ShiftCfg {
  id: string
  name: string
  startMin: number // 当日分钟（0~1440）
  endMin: number
}

export interface MachineCfg {
  id: string
  name: string
  cutSpeedMmPerMin: number // 锯切进给速度
  shifts: ShiftCfg[]
}

export interface ScheduleConfig {
  machines: MachineCfg[]
  toolChangeMin: number // 换刀 / 换刀向（竖刀↔横刀翻台）等待
  materialChangeMin: number // 换板种（材质）等待
  thicknessChangeMin: number // 换厚度等待
  sheetHandlingMin: number // 每张板搬板对位
  strategy: ScheduleStrategy
  horizonDays: number // 排产天数（自开工日起）
}

export function defaultScheduleConfig(): ScheduleConfig {
  const shifts = (): ShiftCfg[] => [
    { id: 'am', name: '早班', startMin: 8 * 60, endMin: 12 * 60 },
    { id: 'pm', name: '午班', startMin: 13 * 60, endMin: 17 * 60 }
  ]
  return {
    machines: [
      { id: 'm1', name: '1号推台锯', cutSpeedMmPerMin: 4500, shifts: shifts() },
      { id: 'm2', name: '2号电子锯', cutSpeedMmPerMin: 6000, shifts: shifts() }
    ],
    toolChangeMin: 4,
    materialChangeMin: 10,
    thicknessChangeMin: 8,
    sheetHandlingMin: 0.6,
    strategy: 'due',
    horizonDays: 3
  }
}

/** 向上取整到一刻钟（15 分钟）。 */
export function ceilQuarter(min: number): number {
  if (min <= 0) return 0
  return Math.ceil(min / QUARTER_MIN - 1e-9) * QUARTER_MIN
}

export function todayStr(): string {
  return dateStrOf(Date.now())
}

export function dateStrOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function addDays(ds: string, n: number): string {
  const d = new Date(`${ds}T00:00:00`)
  d.setDate(d.getDate() + n)
  return dateStrOf(d.getTime())
}

/** 绝对分钟 → 当日时刻 HH:MM。 */
export function clockOf(absMin: number): string {
  const m = ((Math.round(absMin) % DAY_MIN) + DAY_MIN) % DAY_MIN
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(Math.floor(m / 60))}:${p(m % 60)}`
}

// ---------------------------------------------------------------------------
// 单活工时：由刀路工步聚合（同源）

interface GroupSig {
  material: string
  thicknessMm: number
  axis: 'v' | 'h'
}

export interface JobPlan {
  jobId: string
  steps: SawWorkStep[]
  sheets: number
  ops: number // 工步（刀）数 —— 与裁切刀路同源
  vCuts: number
  hCuts: number
  flips: number // 刀向切换次数（换刀等待按此计）
  matChanges: number // 板种切换次数
  thickChanges: number // 厚度切换次数
  cutLenMm: number // 贯通总长度（叠切算一次）
  areaMm2: number // 用板面积（产能统计）
  first: GroupSig
  last: GroupSig
}

export function buildJobPlan(job: Job): JobPlan {
  const sheets = job.result!.sheets
  const steps = buildSawWorkSteps(sheets)
  const matOf = (si: number): { material: string; thicknessMm: number } => ({
    material: sheets[si].material,
    thicknessMm: sheets[si].thicknessMm
  })
  let flips = 0
  let matChanges = 0
  let thickChanges = 0
  let cutLenMm = 0
  let prev: GroupSig | null = null
  let first: GroupSig | null = null
  for (const st of steps) {
    const { material, thicknessMm } = matOf(st.sheetIndices[0])
    const sig: GroupSig = { material, thicknessMm, axis: st.axis }
    if (prev) {
      if (sig.axis !== prev.axis) flips++
      if (sig.material !== prev.material) matChanges++
      if (sig.thicknessMm !== prev.thicknessMm) thickChanges++
    } else {
      first = sig
    }
    prev = sig
    cutLenMm += st.span[1] - st.span[0]
  }
  return {
    jobId: job.id,
    steps,
    sheets: sheets.length,
    ops: steps.length,
    vCuts: steps.filter((s) => s.axis === 'v').length,
    hCuts: steps.filter((s) => s.axis === 'h').length,
    flips,
    matChanges,
    thickChanges,
    cutLenMm,
    areaMm2: sheets.reduce((a, s) => a + s.boardAreaMm2, 0),
    first: first ?? { material: '', thicknessMm: 0, axis: 'v' },
    last: prev ?? { material: '', thicknessMm: 0, axis: 'v' }
  }
}

/** 纯加工分钟（不含机台等待）：贯通长度 ÷ 锯速 + 每张板搬板对位。 */
export function workMinOf(plan: JobPlan, cfg: ScheduleConfig, cutSpeedMmPerMin: number): number {
  return plan.cutLenMm / cutSpeedMmPerMin + cfg.sheetHandlingMin * plan.sheets
}

/** 活内部的机台等待（换刀向 / 换板种 / 换厚度）。 */
export function internalSetupMin(plan: JobPlan, cfg: ScheduleConfig): number {
  return (
    plan.flips * cfg.toolChangeMin +
    plan.matChanges * cfg.materialChangeMin +
    plan.thickChanges * cfg.thicknessChangeMin
  )
}

/** 机台上一个活 → 下一个活之间的等待。 */
function setupBetween(prev: GroupSig, next: GroupSig, cfg: ScheduleConfig): number {
  let s = 0
  if (prev.axis !== next.axis) s += cfg.toolChangeMin
  if (prev.material !== next.material) s += cfg.materialChangeMin
  if (prev.thicknessMm !== next.thicknessMm) s += cfg.thicknessChangeMin
  return s
}

// ---------------------------------------------------------------------------
// 排产结果

export interface ScheduledJob {
  jobId: string
  jobName: string
  machineId: string
  machineName: string
  dayIndex: number
  date: string // 开工=完工 当日（活不跨班次）
  shiftId: string
  shiftName: string
  startMin: number // 绝对分钟（自开工日 00:00）
  finishMin: number
  blockMin: number // 机台占用（含等待，已向上取整到一刻钟）
  setupMin: number // 机台等待合计（接班等待 + 活内等待）
  workMin: number // 纯加工（未取整）
  sheets: number
  ops: number
  vCuts: number
  hCuts: number
  areaMm2: number
  rush: boolean
  dueAt?: number
  overdue: boolean
}

export interface UnscheduledJob {
  jobId: string
  jobName: string
  reason: string
  workMin: number
  ops: number
  sheets: number
}

export interface SkippedJob {
  jobId: string
  jobName: string
  reason: string
}

export interface ShiftLoad {
  key: string
  machineId: string
  dayIndex: number
  shiftId: string
  usedMin: number
  capMin: number
  areaMm2: number
  jobs: number
}

export interface ScheduleResult {
  generatedAt: number
  startDay: string
  horizonDays: number
  strategy: ScheduleStrategy
  machineOrder: string[] // 导出表行序所用的机台顺序
  scheduled: ScheduledJob[]
  unscheduled: UnscheduledJob[]
  skipped: SkippedJob[]
  shiftLoads: ShiftLoad[]
}

export function computeSchedule(
  jobs: Job[],
  cfg: ScheduleConfig,
  startDay: string
): ScheduleResult {
  const skipped: SkippedJob[] = []
  const eligible: { job: Job; plan: JobPlan }[] = []
  for (const j of jobs) {
    if (!j.result) {
      skipped.push({ jobId: j.id, jobName: j.name, reason: '尚未排样：先在排样页生成排样结果' })
      continue
    }
    if (j.result.sheets.length === 0) {
      skipped.push({ jobId: j.id, jobName: j.name, reason: '排样结果没有用板（零件为空或全部未排下）' })
      continue
    }
    eligible.push({ job: j, plan: buildJobPlan(j) })
  }

  // 优先级：交期早的先上机；rush 策略下急件整体插队（组内仍按交期）
  const byDue = (a: { job: Job }, b: { job: Job }): number =>
    (a.job.dueAt ?? Number.POSITIVE_INFINITY) - (b.job.dueAt ?? Number.POSITIVE_INFINITY) ||
    a.job.createdAt - b.job.createdAt
  const ordered = [...eligible].sort(byDue)
  if (cfg.strategy === 'rush') {
    ordered.sort((a, b) => Number(b.job.rush ?? false) - Number(a.job.rush ?? false) || byDue(a, b))
  }

  interface ShiftInst {
    dayIndex: number
    shift: ShiftCfg
    startAbs: number
    endAbs: number
  }
  interface MachState {
    cfg: MachineCfg
    free: number
    last: GroupSig | null
    shifts: ShiftInst[]
  }
  const machines: MachState[] = cfg.machines.map((m) => {
    const shifts: ShiftInst[] = []
    const sorted = [...m.shifts].sort((a, b) => a.startMin - b.startMin)
    for (let d = 0; d < cfg.horizonDays; d++) {
      for (const sh of sorted) {
        shifts.push({
          dayIndex: d,
          shift: sh,
          startAbs: d * DAY_MIN + sh.startMin,
          endAbs: d * DAY_MIN + sh.endMin
        })
      }
    }
    shifts.sort((a, b) => a.startAbs - b.startAbs)
    return { cfg: m, free: 0, last: null, shifts }
  })
  const maxShiftLen = Math.max(0, ...cfg.machines.flatMap((m) => m.shifts.map((s) => s.endMin - s.startMin)))
  const fastest = Math.max(1, ...cfg.machines.map((m) => m.cutSpeedMmPerMin))
  const loadMap = new Map<string, ShiftLoad>()
  const loadOf = (m: MachineCfg, inst: ShiftInst): ShiftLoad => {
    const key = `${m.id}|${inst.dayIndex}|${inst.shift.id}`
    let l = loadMap.get(key)
    if (!l) {
      l = {
        key,
        machineId: m.id,
        dayIndex: inst.dayIndex,
        shiftId: inst.shift.id,
        usedMin: 0,
        capMin: inst.shift.endMin - inst.shift.startMin,
        areaMm2: 0,
        jobs: 0
      }
      loadMap.set(key, l)
    }
    return l
  }

  const scheduled: ScheduledJob[] = []
  const unscheduled: UnscheduledJob[] = []
  for (const { job, plan } of ordered) {
    let best: {
      finish: number
      start: number
      ms: MachState
      inst: ShiftInst
      setupMin: number
      blockMin: number
      workMin: number
    } | null = null
    for (const ms of machines) {
      const workMin = workMinOf(plan, cfg, ms.cfg.cutSpeedMmPerMin)
      const setup = ms.last ? setupBetween(ms.last, plan.first, cfg) : 0
      const block = ceilQuarter(setup + internalSetupMin(plan, cfg) + workMin)
      for (const inst of ms.shifts) {
        if (inst.endAbs <= ms.free) continue
        const start = Math.max(ms.free, inst.startAbs)
        if (start + block > inst.endAbs) continue
        const finish = start + block
        if (!best || finish < best.finish || (finish === best.finish && start < best.start)) {
          best = { finish, start, ms, inst, setupMin: setup, blockMin: block, workMin }
        }
        break // 该机台最早可放的班次已找到
      }
    }
    if (!best) {
      const minBlock = ceilQuarter(internalSetupMin(plan, cfg) + workMinOf(plan, cfg, fastest))
      const reason =
        minBlock > maxShiftLen
          ? `单活占用约 ${minBlock} 分钟（含活内等待），超过最长班次 ${maxShiftLen} 分钟，任何班次都排不下`
          : `排产期内（${cfg.horizonDays} 天）${cfg.machines.length} 台锯的班次已全部排满，没有整段空档放得下`
      unscheduled.push({
        jobId: job.id,
        jobName: job.name,
        reason,
        workMin: workMinOf(plan, cfg, fastest),
        ops: plan.ops,
        sheets: plan.sheets
      })
      continue
    }
    best.ms.free = best.finish
    best.ms.last = plan.last
    const load = loadOf(best.ms.cfg, best.inst)
    load.usedMin += best.blockMin
    load.areaMm2 += plan.areaMm2
    load.jobs++
    const date = addDays(startDay, best.inst.dayIndex)
    scheduled.push({
      jobId: job.id,
      jobName: job.name,
      machineId: best.ms.cfg.id,
      machineName: best.ms.cfg.name,
      dayIndex: best.inst.dayIndex,
      date,
      shiftId: best.inst.shift.id,
      shiftName: best.inst.shift.name,
      startMin: best.start,
      finishMin: best.finish,
      blockMin: best.blockMin,
      setupMin: best.setupMin + internalSetupMin(plan, cfg),
      workMin: best.workMin,
      sheets: plan.sheets,
      ops: plan.ops,
      vCuts: plan.vCuts,
      hCuts: plan.hCuts,
      areaMm2: plan.areaMm2,
      rush: job.rush ?? false,
      dueAt: job.dueAt,
      overdue: job.dueAt !== undefined && date > dateStrOf(job.dueAt)
    })
  }

  return {
    generatedAt: Date.now(),
    startDay,
    horizonDays: cfg.horizonDays,
    strategy: cfg.strategy,
    machineOrder: cfg.machines.map((m) => m.id),
    scheduled,
    unscheduled,
    skipped,
    shiftLoads: [...loadMap.values()]
  }
}

// ---------------------------------------------------------------------------
// 导出表（CSV / 打印 / 差异行号共用同一份行序）

export interface ExportRow {
  no: number // 排产表行号（1 起）
  jobId: string
  jobName: string
  machineName: string
  date: string
  shiftName: string
  startClock: string
  finishClock: string
  blockMin: number
  sheets: number
  ops: number
  areaMm2: number
  dueText: string
  status: string
}

export function exportRows(result: ScheduleResult): ExportRow[] {
  const machineRank = new Map(result.machineOrder.map((id, i) => [id, i]))
  const rows = [...result.scheduled].sort(
    (a, b) =>
      (machineRank.get(a.machineId) ?? 0) - (machineRank.get(b.machineId) ?? 0) ||
      a.dayIndex - b.dayIndex ||
      a.startMin - b.startMin
  )
  return rows.map((s, i) => ({
    no: i + 1,
    jobId: s.jobId,
    jobName: s.jobName,
    machineName: s.machineName,
    date: s.date,
    shiftName: s.shiftName,
    startClock: clockOf(s.startMin),
    finishClock: clockOf(s.finishMin),
    blockMin: s.blockMin,
    sheets: s.sheets,
    ops: s.ops,
    areaMm2: s.areaMm2,
    dueText: s.dueAt !== undefined ? dateStrOf(s.dueAt) : '未设',
    status: s.overdue ? '超期' : s.rush ? '急件' : '正常'
  }))
}

// ---------------------------------------------------------------------------
// 重排差异：改机台速度 / 加班次 / 换策略后逐单对比

export interface ScheduleDiff {
  machineChanged: { jobId: string; jobName: string; from: string; to: string }[]
  timeChanged: { jobId: string; jobName: string; fromText: string; toText: string; deltaMin: number }[]
  rowsChanged: number[] // 新排产表上内容变了的行号
  rowsAdded: number[] // 新排产表新增的行号
  removedJobs: string[] // 从排产表上消失的单
}

function rowSigOf(s: ScheduledJob): string {
  return [s.machineId, s.dayIndex, s.shiftId, s.startMin, s.finishMin, s.ops, s.sheets].join('|')
}

export function compareSchedules(prev: ScheduleResult, next: ScheduleResult): ScheduleDiff {
  const prevById = new Map(prev.scheduled.map((s) => [s.jobId, s]))
  const nextRows = exportRows(next)
  const nextById = new Map(next.scheduled.map((s) => [s.jobId, s]))
  const diff: ScheduleDiff = {
    machineChanged: [],
    timeChanged: [],
    rowsChanged: [],
    rowsAdded: [],
    removedJobs: []
  }
  for (const row of nextRows) {
    const cur = nextById.get(row.jobId)!
    const old = prevById.get(row.jobId)
    if (!old) {
      diff.rowsAdded.push(row.no)
      continue
    }
    if (old.machineId !== cur.machineId) {
      diff.machineChanged.push({
        jobId: row.jobId,
        jobName: row.jobName,
        from: old.machineName,
        to: cur.machineName
      })
    }
    if (old.finishMin !== cur.finishMin || old.dayIndex !== cur.dayIndex) {
      diff.timeChanged.push({
        jobId: row.jobId,
        jobName: row.jobName,
        fromText: `${old.date} ${clockOf(old.finishMin)}`,
        toText: `${cur.date} ${clockOf(cur.finishMin)}`,
        deltaMin: cur.finishMin - old.finishMin
      })
    }
    if (rowSigOf(old) !== rowSigOf(cur)) diff.rowsChanged.push(row.no)
  }
  for (const old of prev.scheduled) {
    if (!nextById.has(old.jobId)) diff.removedJobs.push(old.jobName)
  }
  return diff
}

// ---------------------------------------------------------------------------
// CSV 导出（与打印件同一份行）

export function scheduleCsv(result: ScheduleResult, cfg: ScheduleConfig): string {
  const lines: string[] = []
  lines.push('开料工单排产表')
  lines.push(
    `生成时间,${new Date(result.generatedAt).toLocaleString('zh-CN')},策略,${
      result.strategy === 'rush' ? '急件优先' : '按交期顺排'
    },开工日,${result.startDay},排产天数,${result.horizonDays}`
  )
  lines.push(
    '单位与精度,时间按分钟计并向上取整到一刻钟（15分钟）；面积按mm²累计、折算m²保留2位；刀数与裁切刀路同源'
  )
  lines.push('序号,项目,机台,日期,班次,开工,完工,占用分钟,板数,工步(刀)数,面积m²,交期,状态')
  for (const r of exportRows(result)) {
    lines.push(
      [
        r.no,
        csvCell(r.jobName),
        csvCell(r.machineName),
        r.date,
        csvCell(r.shiftName),
        r.startClock,
        r.finishClock,
        r.blockMin,
        r.sheets,
        r.ops,
        (r.areaMm2 / 1_000_000).toFixed(2),
        r.dueText,
        r.status
      ].join(',')
    )
  }
  if (result.unscheduled.length > 0) {
    lines.push('')
    lines.push('排不进的活（卡在哪）')
    lines.push('项目,板数,工步(刀)数,原因')
    for (const u of result.unscheduled) {
      lines.push([csvCell(u.jobName), u.sheets, u.ops, csvCell(u.reason)].join(','))
    }
  }
  if (result.skipped.length > 0) {
    lines.push('')
    lines.push('未纳入排产的项目')
    lines.push('项目,原因')
    for (const s of result.skipped) {
      lines.push([csvCell(s.jobName), csvCell(s.reason)].join(','))
    }
  }
  lines.push('')
  lines.push(
    `机台等待参数,换刀向${cfg.toolChangeMin}分钟,换板种${cfg.materialChangeMin}分钟,换厚度${cfg.thicknessChangeMin}分钟,搬板对位${cfg.sheetHandlingMin}分钟/张`
  )
  return `﻿${lines.join('\r\n')}` // 带 BOM，Excel 直接打开不乱码
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
