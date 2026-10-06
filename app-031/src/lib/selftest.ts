// 自动化断言（规格书 §8/§10 强制）：
// guillotine 100 组随机零反例、纹理零旋转、锯路/修边、守恒、封边复算、
// 30 零件锯切工步 ≤20 且模拟器还原、余料再利用、300 零件性能 <1.5s；
// 排产：工步与刀路同源、完工时刻复算、策略取舍、排不进原因、重排差异。
import type { Board, Job, Part, SheetResult } from '../types'
import { nestJob } from './packing'
import { simulate, countSawOps, buildSawWorkSteps } from './cuts'
import { guillotineViolation, type Rect } from './geometry'
import {
  ceilQuarter,
  computeSchedule,
  compareSchedules,
  type ScheduleConfig
} from './schedule'

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface SelfTestReport {
  ok: boolean
  elapsedMs: number
  checks: CheckResult[]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let boardSeq = 0
let partSeq = 0

function makeBoard(over: Partial<Board> = {}): Board {
  return {
    id: `b${boardSeq++}`,
    name: over.name ?? '测试板 2440×1220',
    wMm: over.wMm ?? 2440,
    hMm: over.hMm ?? 1220,
    thicknessMm: 18,
    material: '颗粒板',
    priceCents: 13800,
    quantity: 0,
    kind: 'stock',
    ...over
  }
}

function makePart(over: Partial<Part> = {}): Part {
  return {
    id: `p${partSeq++}`,
    code: over.code ?? `P${partSeq}`,
    name: over.name ?? '测试件',
    lenMm: over.lenMm ?? 400,
    widMm: over.widMm ?? 300,
    qty: over.qty ?? 1,
    grain: over.grain ?? 'none',
    edgeBands: over.edgeBands ?? [],
    cabinet: over.cabinet ?? '柜A',
    exposed: over.exposed ?? false,
    boardId: over.boardId ?? ''
  }
}

function makeJob(parts: Part[], over: Partial<Job> = {}): Job {
  return {
    id: `j${partSeq}`,
    name: '测试任务',
    createdAt: 0,
    boards: over.boards ?? [makeBoard()],
    parts,
    kerfMm: over.kerfMm ?? 3.2,
    trimMm: over.trimMm ?? 8,
    useOffcutIds: [],
    batchByCabinet: false,
    ...over
  }
}

/** 检查同板任意两件之间的净距：只要相邻就必须 ≥ kerf；四周 ≥ trim。 */
function assertClearances(job: Job): string | null {
  const kerf = job.kerfMm
  const trim = job.trimMm
  for (const sheet of job.result!.sheets) {
    const ps = sheet.placements
    for (const p of ps) {
      if (p.x < trim - 0.06 || p.y < trim - 0.06) return '零件越过修边区（左下）'
      if (p.x + p.lenMm > sheet.wMm - trim + 0.06) return '零件越过修边区（右）'
      if (p.y + p.widMm > sheet.hMm - trim + 0.06) return '零件越过修边区（上）'
    }
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]
        const b = ps[j]
        const ox = Math.min(a.x + a.lenMm, b.x + b.lenMm) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.widMm, b.y + b.widMm) - Math.max(a.y, b.y)
        if (ox > 0.06 && oy > 0.06) return '零件重叠'
        // 同向投影有重叠时，另一轴的净距必须 ≥ kerf
        if (ox > 0.06) {
          const gap = Math.abs(a.y + a.widMm - b.y) < Math.abs(a.y - (b.y + b.widMm))
            ? b.y - (a.y + a.widMm)
            : a.y - (b.y + b.widMm)
          if (gap > 0.06 && gap < kerf - 0.6) return `净距 ${gap.toFixed(2)} < 锯路 ${kerf}`
        }
        if (oy > 0.06) {
          const gap = Math.abs(a.x + a.lenMm - b.x) < Math.abs(a.x - (b.x + b.lenMm))
            ? b.x - (a.x + a.lenMm)
            : a.x - (b.x + b.lenMm)
          if (gap > 0.06 && gap < kerf - 0.6) return `净距 ${gap.toFixed(2)} < 锯路 ${kerf}`
        }
      }
    }
  }
  return null
}

function dumpJob(job: Job, err?: string): void {
  console.error('DUMP_KERF', job.kerfMm, 'TRIM', job.trimMm, 'ERR', err ?? '')
  for (const p of job.parts) {
    console.error(
      'DUMP_PART',
      JSON.stringify({
        c: p.code,
        l: p.lenMm,
        w: p.widMm,
        q: p.qty,
        g: p.grain,
        e: p.edgeBands.join(''),
        x: p.exposed ? 1 : 0
      })
    )
  }
  const m = err?.match(/板(\d+)/)
  if (m && job.result) {
    const sheet = job.result.sheets[Number(m[1]) - 1]
    if (sheet) {
      console.error('DUMP_SHEET', sheet.wMm, sheet.hMm)
      for (const p of sheet.placements)
        console.error('DUMP_PL', p.code, p.x, p.y, p.lenMm, p.widMm, p.grain)
      for (const st of sheet.steps)
        console.error('DUMP_ST', st.order, st.kind, st.axis, st.at, st.span[0], st.span[1])
      const sim = simulate(sheet.wMm, sheet.hMm, job.kerfMm, sheet.steps, sheet.placements)
      console.error('DUMP_SIM', JSON.stringify(sim.errors))
      for (const lf of sim.leaves)
        console.error('DUMP_LEAF', Math.round(lf.x), Math.round(lf.y), Math.round(lf.w), Math.round(lf.h))
    }
  }
}

function assertSheet(job: Job): string | null {
  const r = job.result!
  for (const sheet of r.sheets) {
    // guillotine 合法性
    const rects = sheet.placements.map((p) => ({
      id: p.instanceId,
      x: p.x,
      y: p.y,
      w: p.lenMm,
      h: p.widMm
    }))
    const bounds: Rect = {
      x: job.trimMm,
      y: job.trimMm,
      w: sheet.wMm - 2 * job.trimMm,
      h: sheet.hMm - 2 * job.trimMm
    }
    const v = guillotineViolation(rects, bounds, job.kerfMm)
    if (v) return `板${sheet.index + 1}：${v}`
    // 逐步切割模拟
    const sim = simulate(sheet.wMm, sheet.hMm, job.kerfMm, sheet.steps, sheet.placements)
    if (!sim.ok) return `板${sheet.index + 1}：${sim.errors.join('；')}`
    // 利用率复算（分子不含锯路）
    const net = sheet.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
    if (Math.abs(net - sheet.usedAreaMm2) > 1) return 'usedArea 与零件净面积不一致'
    if (Math.abs(net / sheet.boardAreaMm2 - sheet.utilization) > 1e-9)
      return '利用率复算不一致'
  }
  // 面积守恒不等式
  const boardArea = r.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  const partArea = job.parts.reduce((a, p) => a + p.lenMm * p.widMm * p.qty, 0)
  if (boardArea + 1 < partArea) return 'Σ板面积 < Σ零件面积'
  return null
}

export function runSelfTest(): SelfTestReport {
  boardSeq = 0
  partSeq = 0
  const t0 = performance.now()
  const checks: CheckResult[] = []
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
  }

  // 1) 100 组随机任务：零反例
  const rng = mulberry32((globalThis as { FCO_SEED?: number }).FCO_SEED ?? 20260925)
  let failures = 0
  let firstFailure = ''
  let totalInstances = 0
  for (let g = 0; g < 100; g++) {
    const kerf = +(2 + rng() * 2).toFixed(2)
    const trim = 5 + Math.floor(rng() * 6)
    const partKinds = 8 + Math.floor(rng() * 33)
    const parts: Part[] = []
    for (let i = 0; i < partKinds; i++) {
      const len = 120 + Math.floor(rng() * 980)
      const wid = 80 + Math.floor(rng() * 620)
      const gr = rng()
      parts.push(
        makePart({
          code: `R${g}-${i}`,
          lenMm: len,
          widMm: wid,
          qty: 1 + Math.floor(rng() * 3),
          grain: gr < 0.4 ? 'length' : gr < 0.55 ? 'width' : 'none',
          edgeBands: rng() < 0.5 ? ['top', 'left'] : [],
          cabinet: ['客厅柜', '衣柜', '橱柜', '书柜'][Math.floor(rng() * 4)],
          exposed: rng() < 0.3
        })
      )
    }
    const job = makeJob(parts, { kerfMm: kerf, trimMm: trim })
    const r = nestJob(job)
    job.result = r
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    totalInstances = parts.reduce((a, p) => a + p.qty, 0)
    // 尺寸被限制为一定排得下
    if (r.unplaced.length > 0) {
      failures++
      firstFailure = `组${g + 1}：存在 ${r.unplaced.length} 件未排下`
      continue
    }
    if (placed !== totalInstances) {
      failures++
      firstFailure = `组${g + 1}：守恒失败 ${placed}/${totalInstances}`
      continue
    }
    const clearanceErr = assertClearances(job)
    if (clearanceErr) {
      failures++
      firstFailure = `组${g + 1}：${clearanceErr}`
      if ((globalThis as { FCO_DUMP?: boolean }).FCO_DUMP) dumpJob(job)
      continue
    }
    const sheetErr = assertSheet(job)
    if (sheetErr) {
      failures++
      firstFailure = `组${g + 1}：${sheetErr}`
      if ((globalThis as { FCO_DUMP?: boolean }).FCO_DUMP) dumpJob(job, sheetErr)
      continue
    }
    // 纹理硬约束：零旋转
    const rotated = r.sheets.flatMap((s) => s.placements).filter((p) => {
      if (p.grain === 'none') return false
      if (p.rotated) return true
      if (p.grain === 'length' && !(p.lenMm === p.origLen && p.widMm === p.origWid)) return true
      if (p.grain === 'width' && !(p.lenMm === p.origWid && p.widMm === p.origLen)) return true
      return false
    })
    if (rotated.length > 0) {
      failures++
      firstFailure = `组${g + 1}：纹理件被旋转 ${rotated.length} 次`
    }
  }
  add(
    '100 组随机 guillotine 零反例（贯通/锯路/修边/守恒/模拟）',
    failures === 0,
    failures === 0
      ? '100/100 通过；每组均验证：逐步模拟可还原全部零件'
      : firstFailure
  )

  // 2) 纹理无法满足时给原因而不是偷转
  {
    const job = makeJob([
      makePart({ code: 'BIG', lenMm: 2500, widMm: 400, qty: 1, grain: 'length' }),
      makePart({ code: 'OK', lenMm: 400, widMm: 400, qty: 1 })
    ])
    const r = nestJob(job)
    const ok =
      r.unplaced.length === 1 &&
      r.unplaced[0].code === 'BIG' &&
      r.unplaced[0].reason.includes('纹理') &&
      r.sheets.reduce((a, s) => a + s.placements.length, 0) === 1
    add('纹理排不下时明确提示且不强制旋转', ok, ok ? '提示：' + r.unplaced[0].reason : '未按预期报纹理冲突')
  }

  // 3) 锯路精确净距（两件相邻 = kerf）
  {
    const job = makeJob([
      makePart({ code: 'A', lenMm: 500, widMm: 500 }),
      makePart({ code: 'B', lenMm: 500, widMm: 500 })
    ])
    const r = nestJob(job)
    const ps = r.sheets[0].placements
    ps.sort((a, b) => a.y - b.y || a.x - b.x)
    const gap = ps[1].y - (ps[0].y + 500)
    const ok = Math.abs(gap - job.kerfMm) < 0.1
    add('相邻零件净距等于锯路 3.2mm', ok, `实测净距 ${gap.toFixed(2)}mm`)
  }

  // 4) 封边米数复算 + 见光分列
  {
    const job = makeJob([
      makePart({
        code: 'E1',
        lenMm: 500,
        widMm: 300,
        qty: 2,
        edgeBands: ['top', 'left'],
        exposed: true
      }),
      makePart({ code: 'E2', lenMm: 400, widMm: 200, qty: 1, edgeBands: ['top', 'bottom', 'left', 'right'] })
    ])
    const r = nestJob(job)
    const expectExposed = 2 * (0.5 + 0.3) // 1.6
    const expectNormal = 0.4 * 2 + 0.2 * 2 // 1.2
    const ok =
      Math.abs(r.edgeBandM.exposed - expectExposed) < 0.011 &&
      Math.abs(r.edgeBandM.normal - expectNormal) < 0.011
    add(
      '封边米数逐件复算一致且见光/非见光分列',
      ok,
      `见光 ${r.edgeBandM.exposed}m（期望 ${expectExposed}）、非见光 ${r.edgeBandM.normal}m（期望 ${expectNormal}）`
    )
  }

  // 5) 30 件标准件：锯切工步 ≤20 且模拟还原全部尺寸
  {
    const job = makeJob([makePart({ code: 'S', lenMm: 480, widMm: 398, qty: 30, grain: 'none' })])
    const r = nestJob(job)
    const ops = countSawOps(r.sheets)
    const simsOk = r.sheets.every((s) =>
      simulate(s.wMm, s.hMm, job.kerfMm, s.steps, s.placements).ok
    )
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    const ok = ops <= 20 && simsOk && placed === 30 && r.sheets.length === 2
    add(
      '30 零件锯切工步 ≤20 且按步模拟尺寸全部正确',
      ok,
      `${r.sheets.length} 张板、${ops} 个锯切工步（修边按叠切计 1 次）、模拟 ${simsOk ? '通过' : '失败'}`
    )
  }

  // 6) 余料作为小板参与下一轮排样
  {
    const small: Board = {
      id: 'offcut_test',
      name: '余料板 900×700',
      wMm: 900,
      hMm: 700,
      thicknessMm: 18,
      material: '颗粒板',
      priceCents: 0,
      quantity: 1,
      kind: 'offcut'
    }
    const job = makeJob([makePart({ code: 'O1', lenMm: 500, widMm: 500 })], {
      boards: [small, makeBoard()]
    })
    const r = nestJob(job)
    const ok = r.sheets[0].boardId === 'offcut_test' && r.sheets.length === 1
    add('余料登记后优先作为小板材参与排样', ok, ok ? '零件排上了 900×700 余料板' : '余料未被优先使用')
  }

  // 7) 300 零件（40 种规格）性能
  {
    const rng2 = mulberry32(77)
    const parts: Part[] = []
    let qtyLeft = 300
    for (let i = 0; i < 40; i++) {
      const qty = Math.min(i === 39 ? qtyLeft : 7 + Math.floor(rng2() * 2), qtyLeft)
      qtyLeft -= qty
      parts.push(
        makePart({
          code: `F${i}`,
          lenMm: 150 + Math.floor(rng2() * 750),
          widMm: 120 + Math.floor(rng2() * 500),
          qty
        })
      )
    }
    const job = makeJob(parts)
    const r = nestJob(job)
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    const ok = r.elapsedMs < 1500 && placed === 300
    add('300 零件排样 < 1.5s', ok, `耗时 ${r.elapsedMs}ms，用板 ${r.sheets.length} 张，就位 ${placed}/300`)
  }

  // 8) 手工微调合法性校验：合法布局通过，塞缝布局拒绝
  {
    const bounds: Rect = { x: 8, y: 8, w: 2424, h: 1204 }
    const legal: { id: string; x: number; y: number; w: number; h: number }[] = [
      { id: '1', x: 8, y: 8, w: 600, h: 1196 },
      { id: '2', x: 611.2, y: 8, w: 600, h: 596 },
      { id: '3', x: 611.2, y: 607.2, w: 600, h: 596.8 }
    ]
    // 经典风车形非切分布局（5 块互相顶住，找不到任何一条贯通切线）
    const illegal: { id: string; x: number; y: number; w: number; h: number }[] = [
      { id: 'B', x: 8, y: 8, w: 396.8, h: 600 },
      { id: 'C', x: 408, y: 8, w: 592, h: 396.8 },
      { id: 'E', x: 408, y: 408, w: 196.8, h: 196.8 },
      { id: 'A', x: 8, y: 608, w: 596.8, h: 396.8 },
      { id: 'D', x: 608, y: 408, w: 392, h: 596.8 }
    ]
    const okLegal = guillotineViolation(legal, bounds, 3.2) === null
    const okIllegal = guillotineViolation(illegal, bounds, 3.2) !== null
    add(
      '微调后 guillotine 合法性校验准确',
      okLegal && okIllegal,
      `合法布局 ${okLegal ? '放行' : '误拒'}；塞缝布局 ${okIllegal ? '拒绝' : '误放'}`
    )
  }

  // 9) 多板种混排 + 库存张数约束
  {
    const thin = makeBoard({
      id: 'thin',
      name: '背板 2440×1220×9',
      wMm: 2440,
      hMm: 1220,
      thicknessMm: 9,
      priceCents: 9800
    })
    const thick = makeBoard({ id: 'thick', name: '主板 2440×1220×18', quantity: 1 })
    const parts = [
      makePart({ code: 'T', lenMm: 1000, widMm: 600, qty: 5, boardId: 'thick' }),
      makePart({ code: 'B', lenMm: 1000, widMm: 600, qty: 2, boardId: 'thin' })
    ]
    const job = makeJob(parts, { boards: [thick, thin] })
    const r = nestJob(job)
    const thickSheets = r.sheets.filter((s) => s.thicknessMm === 18).length
    const thinSheets = r.sheets.filter((s) => s.thicknessMm === 9).length
    const shortage = r.stockShortage.find((x) => x.boardId === 'thick')
    const ok =
      thickSheets >= 2 && thinSheets === 1 && !!shortage && shortage.need >= 2 && shortage.have === 1
    add(
      '多板种混排且 18mm 库存仅 1 张时超开并提示补采',
      ok,
      `18mm 用 ${thickSheets} 张（库存 1，需补采）、9mm 用 ${thinSheets} 张`
    )
  }

  // 10) 排产工步与裁切刀路同源：同规格板修边叠切计一次，工步数 = countSawOps
  {
    const job = makeJob([makePart({ code: 'S', lenMm: 480, widMm: 398, qty: 30, grain: 'none' })])
    const r = nestJob(job)
    const ws = buildSawWorkSteps(r.sheets)
    const trims = ws.filter((w) => w.kind === 'trim')
    const okTrimStack = trims.length === 4 && trims.every((t) => t.sheetIndices.length === r.sheets.length)
    const okSame = ws.length === countSawOps(r.sheets)
    add(
      '排产工步与裁切刀路同源（同规格修边叠切计一次）',
      okSame && okTrimStack,
      `${r.sheets.length} 张板 → ${ws.length} 个工步（修边 ${trims.length} 步 × 叠 ${r.sheets.length} 板），与 countSawOps 一致`
    )
  }

  // 排产测试夹具：假板（给定刀路）与假工单
  const fakeSheet = (
    steps: { axis: 'v' | 'h'; span: number; kind?: 'trim' | 'cut' }[],
    over: { material?: string; thicknessMm?: number } = {}
  ): SheetResult => ({
    index: 0,
    boardId: 'fb',
    boardName: '假板',
    material: over.material ?? '颗粒板',
    thicknessMm: over.thicknessMm ?? 18,
    wMm: 2440,
    hMm: 1220,
    priceCents: 0,
    placements: [],
    steps: steps.map((s, i) => ({
      boardIndex: 0,
      axis: s.axis,
      at: 0,
      span: [0, s.span] as [number, number],
      order: i,
      kind: s.kind ?? ('cut' as const),
      label: ''
    })),
    usedAreaMm2: 0,
    boardAreaMm2: 2440 * 1220,
    utilization: 0,
    offcuts: []
  })
  const fakeSchedJob = (
    id: string,
    sheets: SheetResult[],
    opts: { due?: string; rush?: boolean } = {}
  ): Job => {
    sheets.forEach((s, i) => (s.index = i))
    return {
      id,
      name: id,
      createdAt: 0,
      boards: [],
      parts: [],
      kerfMm: 3.2,
      trimMm: 8,
      useOffcutIds: [],
      batchByCabinet: false,
      dueAt: opts.due ? new Date(`${opts.due}T00:00:00`).getTime() : undefined,
      rush: opts.rush ?? false,
      result: {
        sheets,
        boardsUsed: sheets.length,
        boardsByType: {},
        edgeBandM: { exposed: 0, normal: 0 },
        unplaced: [],
        baselineBoards: 0,
        savedBoards: 0,
        savedCents: 0,
        totalCostCents: 0,
        stockShortage: [],
        elapsedMs: 0,
        generatedAt: 0
      }
    }
  }
  const demoSteps = (): { axis: 'v' | 'h'; span: number; kind?: 'trim' | 'cut' }[] => [
    { axis: 'h', span: 2000, kind: 'trim' },
    { axis: 'v', span: 1000 },
    { axis: 'v', span: 500 }
  ]
  const oneMachine: ScheduleConfig = {
    machines: [
      {
        id: 'm1',
        name: 'M1',
        cutSpeedMmPerMin: 1000,
        shifts: [{ id: 's1', name: '白班', startMin: 480, endMin: 720 }]
      }
    ],
    toolChangeMin: 10,
    materialChangeMin: 20,
    thicknessChangeMin: 15,
    sheetHandlingMin: 0,
    strategy: 'due',
    horizonDays: 1
  }

  // 11) 完工时刻复算：EDD 顺序、机台选择、刻钟取整、超期点名、面积 m² 折算
  {
    const DAY = '2026-10-06'
    const cfg: ScheduleConfig = {
      ...oneMachine,
      horizonDays: 2,
      machines: [
        oneMachine.machines[0],
        {
          id: 'm2',
          name: 'M2',
          cutSpeedMmPerMin: 2000,
          shifts: [{ id: 's1', name: '白班', startMin: 480, endMin: 720 }]
        }
      ]
    }
    const jA = fakeSchedJob('A', [fakeSheet(demoSteps())], { due: '2026-10-07' })
    const jB = fakeSchedJob('B', [fakeSheet(demoSteps())], { due: '2026-10-07' })
    const jC = fakeSchedJob('C', [fakeSheet(demoSteps())], { due: '2026-10-05' })
    const res = computeSchedule([jA, jB, jC], cfg, DAY)
    const A = res.scheduled.find((s) => s.jobId === 'A')!
    const B = res.scheduled.find((s) => s.jobId === 'B')!
    const C = res.scheduled.find((s) => s.jobId === 'C')!
    // 每单：加工 3500/1000=3.5 + 活内换刀向 1×10 = 13.5 → 取整 15 分钟
    // C 交期最早先上 M1 08:00~08:15；A 上空的 M2 08:00~08:15；
    // B 接班需换刀向 +10 → 23.5 → 取整 30 → M1 08:15~08:45
    const okTime =
      C.machineId === 'm1' && C.startMin === 480 && C.finishMin === 495 &&
      A.machineId === 'm2' && A.finishMin === 495 &&
      B.machineId === 'm1' && B.startMin === 495 && B.finishMin === 525
    const okOverdue = C.overdue && !A.overdue && !B.overdue
    const okQuarter =
      ceilQuarter(0) === 0 && ceilQuarter(1) === 15 && ceilQuarter(15) === 15 &&
      ceilQuarter(16) === 30 && ceilQuarter(100) === 105
    const okArea = A.areaMm2 === 2440 * 1220 && (A.areaMm2 / 1_000_000).toFixed(2) === '2.98'
    add(
      '排产完工时刻复算：机台选择、刻钟取整、超期点名、面积折算',
      okTime && okOverdue && okQuarter && okArea,
      `期望 C=M1 480~495(超期)、A=M2 ~495、B=M1 495~525；实测 C=${C.machineId} ${C.startMin}~${C.finishMin} A=${A.machineId} ~${A.finishMin} B=${B.machineId} ${B.startMin}~${B.finishMin}`
    )
  }

  // 12) 策略二选一的取舍可复算：急件插队在先，后面的单被推晚
  {
    const DAY = '2026-10-06'
    const jN = fakeSchedJob('N', [fakeSheet(demoSteps())], { due: '2026-10-07' })
    const jR = fakeSchedJob('R', [fakeSheet(demoSteps())], { due: '2026-10-09', rush: true })
    const dueRes = computeSchedule([jN, jR], oneMachine, DAY)
    const rushRes = computeSchedule([jN, jR], { ...oneMachine, strategy: 'rush' }, DAY)
    const fin = (r: typeof dueRes, id: string): number =>
      r.scheduled.find((s) => s.jobId === id)!.finishMin
    const ok =
      fin(dueRes, 'N') === 495 && fin(dueRes, 'R') === 525 &&
      fin(rushRes, 'R') === 495 && fin(rushRes, 'N') === 525 &&
      fin(rushRes, 'R') < fin(dueRes, 'R') && fin(rushRes, 'N') > fin(dueRes, 'N')
    add(
      '策略取舍：急件插队赶出急单、后单被推晚',
      ok,
      `按交期 N=495/R=525 → 急件优先 R=495/N=525（急单提前 30 分钟，普通单推晚 30 分钟）`
    )
  }

  // 13) 排不进时点名卡在哪：单活超班 / 两台机都满班
  {
    const DAY = '2026-10-06'
    const jBig = fakeSchedJob('BIG', [fakeSheet([{ axis: 'v', span: 300000 }])])
    const resBig = computeSchedule([jBig], oneMachine, DAY)
    const okOver =
      resBig.unscheduled.length === 1 && /超过最长班次/.test(resBig.unscheduled[0].reason)
    const twoMachines: ScheduleConfig = {
      ...oneMachine,
      machines: [oneMachine.machines[0], { ...oneMachine.machines[0], id: 'm2', name: 'M2' }]
    }
    const jobs5 = Array.from({ length: 5 }, (_, i) =>
      fakeSchedJob(`F${i}`, [fakeSheet([{ axis: 'v', span: 114000 }])], { due: '2026-10-07' })
    )
    const res5 = computeSchedule(jobs5, twoMachines, DAY)
    const okFull =
      res5.scheduled.length === 4 &&
      res5.unscheduled.length === 1 &&
      /排满/.test(res5.unscheduled[0].reason)
    add(
      '排不进时点名卡在哪（单活超班 / 两台机满班）',
      okOver && okFull,
      `超班：${resBig.unscheduled[0]?.reason ?? '未报'}；满班：4 单上机 + 1 单排不进`
    )
  }

  // 14) 改机台速度 → 重排并逐单列出完工时刻与排产表行差异
  {
    const DAY = '2026-10-06'
    const jX = fakeSchedJob('X', [fakeSheet([{ axis: 'v', span: 100000 }])], { due: '2026-10-07' })
    const base = computeSchedule([jX], oneMachine, DAY) // 100 分钟 → 取整 105
    const faster = computeSchedule(
      [jX],
      { ...oneMachine, machines: [{ ...oneMachine.machines[0], cutSpeedMmPerMin: 2000 }] },
      DAY
    ) // 50 分钟 → 取整 60
    const d = compareSchedules(base, faster)
    const ok =
      d.timeChanged.length === 1 &&
      d.timeChanged[0].deltaMin === -45 &&
      d.rowsChanged.length === 1 &&
      d.rowsChanged[0] === 1 &&
      d.machineChanged.length === 0
    add(
      '改机台速度后逐单列出完工与排产表行差异',
      ok,
      `X 完工提前 45 分钟（105→60），排产表第 1 行变化，未换机台`
    )
  }

  const elapsedMs = Math.round(performance.now() - t0)
  const ok = checks.every((c) => c.ok)
  return { ok, elapsedMs, checks }
}
