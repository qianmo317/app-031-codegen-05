// 排产状态：reactive 单例 + localStorage 持久化。
// 关键设计：排产结果是对 (项目列表, 排产配置) 的 computed —— 改任何一处（重排样、改交期、
// 调机台速度、加班次、换策略）都会自动重算，开料工单页 / 项目列表页 / 导出打印三处
// 消费同一个 computed，不存在「工单页重排了、列表页还挂旧完工时刻」的窗口。
import { computed, reactive, type ComputedRef } from 'vue'
import { useStore } from './store'
import {
  computeSchedule,
  compareSchedules,
  defaultScheduleConfig,
  exportRows,
  todayStr,
  type ScheduleConfig,
  type ScheduleDiff,
  type ScheduleResult,
  type ScheduleStrategy
} from './schedule'
import { uid } from './format'

const CFG_KEY = 'fco.sched.cfg.v1'
const VER_KEY = 'fco.sched.versions.v1'
const META_KEY = 'fco.sched.meta.v1'

/** 存档的一版排产（机台班次配置 + 结果快照；作废后仅留档，不再生效）。 */
export interface ScheduleVersion {
  id: string
  savedAt: number
  strategy: ScheduleStrategy
  config: ScheduleConfig
  result: ScheduleResult
  exportedAt?: number // 这版曾被导出/打印过
  voidedAt?: number // 已作废（选错策略回退重排）
}

interface SchedMeta {
  diffBase: ScheduleResult | null // 上一次配置变更前的排产（差异对比基准）
  lastExportSig: string | null // 最近一次导出/打印的排产表内容签名
  lastExportAt: number | null
}

interface SchedState {
  config: ScheduleConfig
  versions: ScheduleVersion[]
  meta: SchedMeta
  loaded: boolean
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const schedState = reactive<SchedState>({
  config: defaultScheduleConfig(),
  versions: [],
  meta: { diffBase: null, lastExportSig: null, lastExportAt: null },
  loaded: false
})

let liveRef: ComputedRef<ScheduleResult> | null = null

function persist(): void {
  localStorage.setItem(CFG_KEY, JSON.stringify(schedState.config))
  localStorage.setItem(VER_KEY, JSON.stringify(schedState.versions))
  localStorage.setItem(META_KEY, JSON.stringify(schedState.meta))
}

function init(): void {
  if (schedState.loaded) return
  const cfg = load<Partial<ScheduleConfig>>(CFG_KEY, {})
  schedState.config = { ...defaultScheduleConfig(), ...cfg }
  schedState.versions = load<ScheduleVersion[]>(VER_KEY, [])
  schedState.meta = { diffBase: null, lastExportSig: null, lastExportAt: null, ...load(META_KEY, {}) }
  // live 结果依赖项目列表，需等 store 就绪后建立（useStore 幂等）
  const { state } = useStore()
  liveRef = computed(() => computeSchedule(state.jobs, schedState.config, todayStr()))
  schedState.loaded = true
}

/** 排产表内容签名：导出/作废判同用（行序与导出表一致）。 */
export function resultSig(r: ScheduleResult): string {
  return JSON.stringify(
    exportRows(r).map((x) => [x.jobId, x.machineName, x.date, x.shiftName, x.startClock, x.finishClock, x.ops, x.sheets])
  )
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export function useSchedule() {
  init()
  const live = liveRef!

  /** 重排差异：配置变更前的排产 vs 当前排产（改机台速度/加班次/换策略后逐单对比）。 */
  const diff = computed<ScheduleDiff | null>(() =>
    schedState.meta.diffBase ? compareSchedules(schedState.meta.diffBase, live.value) : null
  )
  /** 上次导出后排产又变了：发出去的排产表已失效。 */
  const exportStale = computed(
    () =>
      schedState.meta.lastExportSig !== null &&
      schedState.meta.lastExportSig !== resultSig(live.value)
  )
  /** 已作废且曾导出过的存档（发出的排产表需追回重发）。 */
  const voidedExported = computed(() => schedState.versions.filter((v) => v.voidedAt && v.exportedAt))

  /** 改配置（机台速度/班次/等待/策略/排产天数）：先留对比基准，再变更 → 自动重排。 */
  function applyConfigChange(mut: (cfg: ScheduleConfig) => void): void {
    schedState.meta.diffBase = clone(live.value)
    mut(schedState.config)
    persist()
  }

  function setStrategy(strategy: ScheduleStrategy): void {
    if (schedState.config.strategy === strategy) return
    applyConfigChange((cfg) => {
      cfg.strategy = strategy
    })
  }

  function clearDiff(): void {
    schedState.meta.diffBase = null
    persist()
  }

  /** 把当前生效的排产存进本机存档。 */
  function archiveCurrent(): ScheduleVersion {
    const sig = resultSig(live.value)
    const v: ScheduleVersion = {
      id: uid('sv'),
      savedAt: Date.now(),
      strategy: schedState.config.strategy,
      config: clone(schedState.config),
      result: clone(live.value),
      exportedAt:
        schedState.meta.lastExportSig === sig ? schedState.meta.lastExportAt ?? undefined : undefined
    }
    schedState.versions.unshift(v)
    persist()
    return v
  }

  /**
   * 作废一版存档并回退重排：该版的机台班次配置与结果全部作废；
   * 策略换到另一条路（二选一互斥），当前排产自动重算 —— 项目列表的交期状态、
   * 工单页与导出件随之刷新；若该版曾导出，由 voidedExported 提示追回重发。
   */
  function voidVersion(id: string): void {
    const v = schedState.versions.find((x) => x.id === id)
    if (!v || v.voidedAt) return
    v.voidedAt = Date.now()
    applyConfigChange((cfg) => {
      cfg.strategy = v.strategy === 'rush' ? 'due' : 'rush'
    })
  }

  /** 记录一次导出/打印：内容签名存档，之后的变更会触发「排产表已失效」。 */
  function markExported(): void {
    const sig = resultSig(live.value)
    schedState.meta.lastExportSig = sig
    schedState.meta.lastExportAt = Date.now()
    for (const v of schedState.versions) {
      if (!v.voidedAt && resultSig(v.result) === sig) v.exportedAt = schedState.meta.lastExportAt
    }
    persist()
  }

  function resetConfig(): void {
    applyConfigChange((cfg) => Object.assign(cfg, defaultScheduleConfig()))
  }

  return {
    schedState,
    live,
    diff,
    exportStale,
    voidedExported,
    applyConfigChange,
    setStrategy,
    clearDiff,
    archiveCurrent,
    voidVersion,
    markExported,
    resetConfig
  }
}
