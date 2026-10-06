// 排产存档（localStorage）：版本、发布/导出/作废回退、刀路过期检测。
// 三处（工单页 / 项目列表页 / 导出打印）都只从 currentVersion 取数，改一处全部刷新。
import { reactive, computed } from 'vue'
import type {
  Job,
  SawMachine,
  ScheduleParams,
  SchedulePolicy,
  ScheduleVersion,
  Shift
} from '../types'
import {
  DEFAULT_PARAMS,
  defaultMachines,
  defaultShifts,
  diffVersions,
  fingerprintOf,
  jobInputSignature,
  runSchedule,
  todayStr,
  type ScheduleInput
} from './schedule'
import { uid } from './format'

const CFG_KEY = 'fco.schedule.cfg.v1'
const VER_KEY = 'fco.schedule.versions.v1'

interface ScheduleConfig {
  policy: SchedulePolicy
  horizonStartDate: string
  machines: SawMachine[]
  shifts: Shift[]
  params: ScheduleParams
}

interface ScheduleStoreState {
  cfg: ScheduleConfig
  versions: ScheduleVersion[]
  loaded: boolean
}

function loadCfg(): ScheduleConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY)
    if (raw) {
      const c = JSON.parse(raw) as ScheduleConfig
      if (c.machines?.length && c.shifts?.length && c.params) return c
    }
  } catch {
    /* ignore */
  }
  return {
    policy: 'edd',
    horizonStartDate: todayStr(),
    machines: defaultMachines(),
    shifts: defaultShifts(),
    params: JSON.parse(JSON.stringify(DEFAULT_PARAMS))
  }
}

const ss = reactive<ScheduleStoreState>({
  cfg: loadCfg(),
  versions: [],
  loaded: false
})

function persist(): void {
  localStorage.setItem(CFG_KEY, JSON.stringify(ss.cfg))
  localStorage.setItem(VER_KEY, JSON.stringify(ss.versions))
}

function init(): void {
  if (ss.loaded) return
  try {
    const raw = localStorage.getItem(VER_KEY)
    if (raw) {
      const arr = JSON.parse(raw) as ScheduleVersion[]
      if (Array.isArray(arr)) ss.versions = arr
    }
  } catch {
    /* ignore */
  }
  ss.loaded = true
}

/** 当前生效版本（draft/published 唯一；voided 的不算）。 */
export const currentVersion = computed<ScheduleVersion | undefined>(() =>
  ss.versions.find((v) => v.status !== 'voided')
)

export const lastVoided = computed<ScheduleVersion | undefined>(() =>
  [...ss.versions].reverse().find((v) => v.status === 'voided')
)

export function useScheduleStore() {
  init()
  return { ss, currentVersion, lastVoided }
}

// ── 配置编辑（改机速/加班次后不自动覆盖已发布版本，先出差异再发布）──────────

export function updateMachine(id: string, patch: Partial<SawMachine>): void {
  init()
  const m = ss.cfg.machines.find((x) => x.id === id)
  if (m) Object.assign(m, patch)
  persist()
}

export function addMachine(): void {
  init()
  const n = ss.cfg.machines.length + 1
  ss.cfg.machines.push({
    id: uid('saw'),
    name: `${n} 号锯`,
    speedFactor: 1,
    shiftIds: ss.cfg.shifts.length ? [ss.cfg.shifts[0].id] : []
  })
  persist()
}

export function addShift(over: Partial<Shift> = {}): Shift {
  init()
  const sh: Shift = {
    id: uid('shift'),
    name: over.name ?? `班次${ss.cfg.shifts.length + 1}`,
    startMin: over.startMin ?? 18 * 60,
    endMin: over.endMin ?? 22 * 60,
    weekdays: over.weekdays ?? []
  }
  ss.cfg.shifts.push(sh)
  persist()
  return sh
}

export function updateShift(id: string, patch: Partial<Shift>): void {
  init()
  const sh = ss.cfg.shifts.find((x) => x.id === id)
  if (sh) Object.assign(sh, patch)
  persist()
}

export function removeShift(id: string): void {
  init()
  ss.cfg.shifts = ss.cfg.shifts.filter((x) => x.id !== id)
  for (const m of ss.cfg.machines) m.shiftIds = m.shiftIds.filter((s) => s !== id)
  persist()
}

export function setPolicy(p: SchedulePolicy): void {
  init()
  ss.cfg.policy = p
  persist()
}

export function setHorizonStart(date: string): void {
  init()
  ss.cfg.horizonStartDate = date
  persist()
}

export function updateParams(patch: Partial<ScheduleParams>): void {
  init()
  Object.assign(ss.cfg.params, patch)
  persist()
}

export function updateSetup(patch: Partial<ScheduleParams['setup']>): void {
  init()
  Object.assign(ss.cfg.params.setup, patch)
  persist()
}

// ── 重算 / 发布 / 导出 / 作废回退 ───────────────────────────────────────────

function inputFor(jobs: Job[]): ScheduleInput {
  return {
    jobs,
    machines: ss.cfg.machines,
    shifts: ss.cfg.shifts,
    params: ss.cfg.params,
    policy: ss.cfg.policy,
    horizonStartDate: ss.cfg.horizonStartDate
  }
}

export interface RecomputeResult {
  version: ScheduleVersion
  diff: ReturnType<typeof diffVersions>
  /** 当前生效版本基于的刀路/交期输入是否已被改动（需要重排后再发） */
  stale: boolean
  staleJobs: string[]
  /** 配置（机速/班次/参数/策略/起始日）相对已发布版本是否变了 */
  configChanged: boolean
}

/** 用当前配置 + 当前所有活重算一版（不落库），并与生效版本做差异。 */
export function previewSchedule(jobs: Job[]): RecomputeResult {
  init()
  const version = runSchedule(inputFor(jobs))
  const cur = currentVersion.value
  version.status = cur ? cur.status : 'draft'
  const diff = diffVersions(cur, version)

  // 把当前活按生效版本当时的机台/班次/参数/策略重算一遍：
  // 指纹仍对不上，就只可能是活本身变了（刀路重排/微调、交期、急件）。
  const staleJobs: string[] = []
  let configChanged = false
  if (cur) {
    configChanged = cur.fingerprint !== fingerprintOf(inputFor(jobs))
    const sameConfigFp = fingerprintOf({
      jobs,
      machines: cur.machines,
      shifts: cur.shifts,
      params: cur.params,
      policy: cur.policy,
      horizonStartDate: cur.horizonStartDate
    })
    if (sameConfigFp !== cur.fingerprint) {
      for (const j of jobs) {
        if (!j.result) continue
        if (cur.jobInputFp?.[j.id] !== jobInputSignature(j)) staleJobs.push(j.name)
      }
    }
  }
  return { version, diff, stale: staleJobs.length > 0, staleJobs, configChanged }
}

/** 重算并落库为新生效版本；若已有生效版本则旧版标记作废（版本链可追溯）。 */
export function publishSchedule(jobs: Job[]): {
  version: ScheduleVersion
  diff: ReturnType<typeof diffVersions>
  voided: ScheduleVersion | undefined
} {
  init()
  const preview = previewSchedule(jobs)
  const version = preview.version
  version.status = 'published'
  version.createdAt = Date.now()
  const cur = currentVersion.value
  if (cur) {
    cur.status = 'voided'
    cur.supersededBy = version.id
  }
  version.status = 'published'
  ss.versions.push(version)
  // 存档只留最近 20 个版本（作废链），更早的清掉避免 localStorage 膨胀
  if (ss.versions.length > 20) ss.versions.splice(0, ss.versions.length - 20)
  persist()
  return { version, diff: preview.diff, voided: cur }
}

/** 排产表已导出/打印（发出去）。 */
export function markExported(versionId: string): void {
  init()
  const v = ss.versions.find((x) => x.id === versionId)
  if (v && v.status === 'published') {
    v.exported = true
    v.exportedAt = Date.now()
    persist()
  }
}

export function isExported(v: ScheduleVersion): boolean {
  return v.exported
}

/**
 * 选错的那条路已经存进本机存档并导出排产表 → 作废：
 * - 生效版本置 voided（存档里的机台班次/完工时刻原样保留为作废记录，
 *   currentVersion 立即不再消费它，工单页、项目列表页、导出页三处同时回退到"待重排"）；
 * - 已导出（发出去）的版本返回 needRecall=true，由界面点名需要撤回的旧排产表；
 * - 作废后由用户在两条策略里重选（让出急件响应速度或整体平稳），再 publishSchedule 重排。
 */
export function voidPublished(): { voided: ScheduleVersion; needRecall: boolean } | null {
  init()
  const cur = currentVersion.value
  if (!cur) return null
  cur.status = 'voided'
  persist()
  return { voided: cur, needRecall: cur.exported }
}

/** 作废并重排：用当前配置立刻生成新版本（配置可先切换策略/机速/班次）。 */
export function rollbackAndRepublish(
  jobs: Job[]
): { voided: ScheduleVersion; newVersion: ScheduleVersion; diff: ReturnType<typeof diffVersions> } | null {
  const v = voidPublished()
  if (!v) return null
  const pub = publishSchedule(jobs)
  return { voided: v.voided, newVersion: pub.version, diff: pub.diff }
}

// ── 三处消费的唯一取数口 ────────────────────────────────────────────────────

export interface JobScheduleStatus {
  scheduled: boolean
  late: boolean
  lateMin: number
  finishQuarterMin: number | null
  machineName: string | null
  versionStatus: ScheduleVersion['status'] | null
  versionId: string | null
  exported: boolean
  policy: SchedulePolicy | null
}

/** 项目列表页 / 工单页 / 导出页查某单交期状态，全部走这里。 */
export function jobScheduleStatus(jobId: string): JobScheduleStatus {
  init()
  const v = currentVersion.value
  const j = v?.jobs.find((x) => x.jobId === jobId)
  if (!v || !j)
    return {
      scheduled: false,
      late: false,
      lateMin: 0,
      finishQuarterMin: null,
      machineName: null,
      versionStatus: null,
      versionId: null,
      exported: false,
      policy: null
    }
  return {
    scheduled: true,
    late: j.late,
    lateMin: j.lateMin,
    finishQuarterMin: j.finishQuarterMin,
    machineName: j.machineName,
    versionStatus: v.status,
    versionId: v.id,
    exported: v.exported,
    policy: v.policy
  }
}

/** 当前配置下是否还没有任何生效排产（引导提示用）。 */
export function hasSchedule(): boolean {
  init()
  return !!currentVersion.value
}
