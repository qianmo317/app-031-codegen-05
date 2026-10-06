// 数据模型（对应规格书 §7，进阶功能所需字段为可选扩展）

export type GrainDemand = 'length' | 'width' | 'none' // 竖纹 / 横纹 / 无要求
export type EdgeSide = 'top' | 'bottom' | 'left' | 'right'

export interface Board {
  id: string
  name: string
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  priceCents: number
  quantity: number // 库存张数，0 = 不限
  kind?: 'stock' | 'offcut' // stock 常规板材 / offcut 登记余料转来的小板
  offcutId?: string
}

export interface Part {
  id: string
  code: string
  name: string
  lenMm: number
  widMm: number
  qty: number
  grain: GrainDemand
  edgeBands: EdgeSide[]
  cabinet: string // 所在柜体/房间，便于分拣
  exposed: boolean // 是否见光
  boardId?: string // 指定板材类型，空 = 自动
}

export interface Placement {
  partId: string
  instanceId: string
  boardIndex: number
  x: number
  y: number
  lenMm: number // 实际占 x 方向的尺寸（纹理=横纹时为零件 wid，rotated 仍为 false）
  widMm: number // 实际占 y 方向的尺寸
  origLen: number // 清单录入尺寸（标签用）
  origWid: number
  rotated: boolean
  seq: number
  // 冗余展示字段
  code: string
  name: string
  cabinet: string
  exposed: boolean
  grain: GrainDemand
  edgeBands: EdgeSide[]
  adjusted?: boolean // 手工微调产生
}

export interface CutStep {
  boardIndex: number
  axis: 'v' | 'h'
  at: number // 切割线坐标（mm，板左下角原点）
  span: [number, number] // 贯通区间起止
  order: number
  kind: 'trim' | 'cut'
  label: string
}

export interface OffcutInfo {
  x: number
  y: number
  wMm: number
  hMm: number
  areaMm2: number
  usable: boolean // 两边 ≥300mm 才登记为可用余料，其余仅作碎料留档
}

export interface SheetResult {
  index: number
  boardId: string
  boardName: string
  material: string
  thicknessMm: number
  wMm: number
  hMm: number
  priceCents: number
  placements: Placement[]
  steps: CutStep[]
  usedAreaMm2: number
  boardAreaMm2: number
  utilization: number
  offcuts: OffcutInfo[]
  adjusted?: boolean
}

export interface UnplacedInfo {
  partId: string
  code: string
  name: string
  qty: number
  reason: string
}

export interface NestResult {
  sheets: SheetResult[]
  boardsUsed: number
  boardsByType: Record<string, number>
  edgeBandM: { exposed: number; normal: number }
  unplaced: UnplacedInfo[]
  baselineBoards: number // 随手排（朴素顺板）需要的张数
  savedBoards: number
  savedCents: number
  totalCostCents: number
  stockShortage: { boardId: string; boardName: string; need: number; have: number }[]
  elapsedMs: number
  generatedAt: number
}

export interface Job {
  id: string
  name: string
  createdAt: number
  boards: Board[]
  parts: Part[]
  kerfMm: number
  trimMm: number
  useOffcutIds: string[] // 参与本单排样的登记余料
  batchByCabinet: boolean // 按柜体批次分组开料
  result?: NestResult
  // 排产输入（可选；无交期的单不参与排产）
  dueAt?: number // 交期时刻（时间戳），默认按交期当日下班点比较
  urgent?: boolean // 急件标记：「先插急件」策略下插队到队首
  /** 排产工步所依据的刀路指纹（sheetCount+每板刀数签名）；刀路变更后用于判定排产表过期 */
  cutFingerprint?: string
}

export interface RegisteredOffcut {
  id: string
  jobId: string
  jobName: string
  sheetIndex: number
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  createdAt: number
  available: boolean
  usedByJobId?: string
}

// ── 开料工单排产 ────────────────────────────────────────────────────────────

export type SchedulePolicy = 'urgent-first' | 'edd'
export type OpKind = 'trim' | 'cut' | 'setup' // 修边叠切 / 内部刀裁切 / 换型等待

/** 班次（以分钟表示的每日时钟，如 08:00 = 480）。 */
export interface Shift {
  id: string
  name: string // 白班 / 晚班
  startMin: number
  endMin: number // 允许跨 24:00（>1440）
  weekdays: number[] // 0=周日 … 6=周六；空数组 = 每天
}

export interface SawMachine {
  id: string
  name: string
  speedFactor: number // 相对速度倍率：1 = 标准，1.2 = 快 20%
  shiftIds: string[] // 该机台开通的班次
}

/** 换型等待（分钟，整数；不向上取整一刻钟）。 */
export interface SetupMinutes {
  blade: number // 换刀向（横↔竖）
  material: number // 换板种（材质）
  thickness: number // 换厚度
}

export interface ScheduleParams {
  horizonDays: number // 排产天数上限（卡住时说明原因用）
  setup: SetupMinutes
  cutSecondsPerBlade: number // 每刀基础秒数（刀路里的 1 刀）
  handleSecondsPerBoard: number // 每叠 1 张板的搬运/对刀秒数
  quarterMin: number // 加工时长向上取整一刻钟（15 分钟）
  speedFactorBase: number // 标准机台速度（展示用，恒为 1）
}

/** 刀路同源工步：trim = 同规格板修边叠切一次；cut = 同内部刀路板叠切一次。 */
export interface ScheduleOp {
  id: string // 机器无关的稳定键（diff 时同一行对得上）
  kind: OpKind
  jobId: string
  jobName: string
  boardDesc: string // 板规格描述（如 2440×1220×18 颗粒板）
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  stackSheets: number // 叠切张数
  bladeCount: number // 刀数（直接取刀路步骤数；setup 工步为 0）
  axis: 'v' | 'h' | null // 首刀方向：换刀向等待的判定依据
  rawMin: number // 未取整的加工分钟（板数×搬运 + 刀数×刀时）/ 机速
  workMin: number // 加工时长（向上取整一刻钟）
  setupMin: number // 因换刀向/换板种/换厚度产生的等待分钟
  /** 刀路出处：来自哪几张板的哪些刀序（不许另估一套数） */
  source: { sheetIndex: number; orderFrom: number; orderTo: number; kind: 'trim' | 'cut' }[]
}

export interface ScheduleRow {
  rowId: string
  machineId: string
  machineName: string
  shiftId: string
  shiftName: string
  dayIndex: number // 排产起始日起第几天（0 基）
  op: ScheduleOp
  startMin: number // 相对排产零点的分钟（整数分钟，跨天累加）
  endMin: number
  setupFromRowId?: string // 等待所相对的上一工步
  reasons?: string[] // setup 行：换刀向/换板种/换厚度
  changed?: boolean // diff 标记：相对上一版该行有变
}

export interface JobSchedule {
  jobId: string
  jobName: string
  machineId: string
  machineName: string
  startMin: number
  endMin: number // 内部整数分钟完工时刻
  finishQuarterMin: number // 向上取整到一刻钟的完工时刻（对交期、展示、打印唯一口径）
  dueAt: number | null
  lateMin: number // >0 即赶不上交期（一刻钟口径 - 交期）
  late: boolean
  areaMm2: number // 本单加工面积（平方毫米）
  opCount: number
  workMin: number // 加工分钟合计（已取整）
  setupMin: number // 等待分钟合计
  rows: ScheduleRow[]
  changed?: boolean // diff 标记
}

export interface UnscheduledJob {
  jobId: string
  jobName: string
  reason: string
  detail: string
}

export interface ScheduleVersion {
  id: string
  createdAt: number
  policy: SchedulePolicy
  horizonStartMin: number // 排产零点（分钟时间戳）
  horizonStartDate: string // YYYY-MM-DD
  machines: SawMachine[]
  shifts: Shift[]
  params: ScheduleParams
  rows: ScheduleRow[]
  jobs: JobSchedule[]
  unscheduled: UnscheduledJob[]
  lateJobIds: string[]
  totalAreaMm2: number
  notes: string // 策略取舍说明（随存档与导出走）
  status: 'draft' | 'published' | 'voided'
  exported: boolean // 排产表是否已导出/打印（发出去）
  exportedAt?: number
  supersededBy?: string // 作废后由哪一版重排替代
  fingerprint: string // 输入（活+机台+班次+参数+策略）指纹，参数改动据此识别
  jobInputFp?: Record<string, string> // 每单（交期/急件/刀路）输入指纹，刀路重排后据此点名过期单
}

export interface ScheduleDiff {
  hasPrevious: boolean
  machineChanged: { jobId: string; jobName: string; from: string; to: string }[]
  finishChanged: { jobId: string; jobName: string; fromMin: number; toMin: number }[]
  rowsChanged: number // 排产表变化行数（机台/班次/起止时刻任一不同）
  rowsAdded: number
  rowsRemoved: number
  newLate: { jobId: string; jobName: string }[] // 上版不超期 → 本版超期
  rescued: { jobId: string; jobName: string }[] // 上版超期 → 本版不超期
  prevVersionId?: string
}
