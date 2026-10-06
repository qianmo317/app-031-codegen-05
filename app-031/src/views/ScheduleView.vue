<script setup lang="ts">
import { computed } from 'vue'
import { useStore, saveJob } from '../lib/store'
import { useSchedule, resultSig } from '../lib/scheduleStore'
import {
  addDays,
  clockOf,
  dateStrOf,
  scheduleCsv,
  type MachineCfg,
  type ScheduleStrategy
} from '../lib/schedule'
import { printSchedule } from '../lib/print'
import { areaM2, downloadText, uid } from '../lib/format'
import { toast } from '../lib/ui'
import type { Job } from '../types'

const { state } = useStore()
const {
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
} = useSchedule()

const cfg = computed(() => schedState.config)

// ---------------------------------------------------------------------------
// 工单表：按机台 × 天 × 班次分组（与导出表同源，同一份 live 结果）

const board = computed(() => {
  const loadMap = new Map(live.value.shiftLoads.map((l) => [l.key, l]))
  return cfg.value.machines.map((m) => ({
    machine: m,
    days: Array.from({ length: cfg.value.horizonDays }, (_, d) => {
      const shifts = [...m.shifts].sort((a, b) => a.startMin - b.startMin)
      return {
        dayIndex: d,
        date: addDays(live.value.startDay, d),
        shifts: shifts.map((sh) => ({
          shift: sh,
          load: loadMap.get(`${m.id}|${d}|${sh.id}`),
          jobs: live.value.scheduled.filter(
            (s) => s.machineId === m.id && s.dayIndex === d && s.shiftId === sh.id
          )
        }))
      }
    })
  }))
})

const dayLabel = (d: number): string => ['今天', '明天', '后天'][d] ?? `第${d + 1}天`

const scheduledByJob = computed(() => new Map(live.value.scheduled.map((s) => [s.jobId, s])))
const unscheduledByJob = computed(() => new Map(live.value.unscheduled.map((u) => [u.jobId, u])))
const skippedByJob = computed(() => new Map(live.value.skipped.map((s) => [s.jobId, s])))

// ---------------------------------------------------------------------------
// 交期 / 急件设置（改即重排，三处同源刷新）

function onDue(job: Job, e: Event): void {
  const v = (e.target as HTMLInputElement).value
  job.dueAt = v ? new Date(`${v}T00:00:00`).getTime() : undefined
  saveJob(job)
}
function onRush(job: Job, e: Event): void {
  job.rush = (e.target as HTMLInputElement).checked
  saveJob(job)
}

// ---------------------------------------------------------------------------
// 机台与班次配置（改即重排，并留下差异对比）

function setSpeed(m: MachineCfg, e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (!v || v <= 0) {
    toast('锯速需为正数（mm/min）', 'bad')
    return
  }
  applyConfigChange((c) => {
    c.machines.find((x) => x.id === m.id)!.cutSpeedMmPerMin = v
  })
  toast(`已重排：${m.name} 锯速改为 ${v} mm/min`, 'good')
}
function setShiftTime(m: MachineCfg, shiftId: string, field: 'startMin' | 'endMin', e: Event): void {
  const v = (e.target as HTMLInputElement).value // HH:MM
  if (!v) return
  const [h, mm] = v.split(':').map(Number)
  const min = h * 60 + mm
  applyConfigChange((c) => {
    const sh = c.machines.find((x) => x.id === m.id)!.shifts.find((s) => s.id === shiftId)
    if (sh) sh[field] = min
  })
}
function setShiftName(m: MachineCfg, shiftId: string, e: Event): void {
  const v = (e.target as HTMLInputElement).value.trim()
  if (!v) return
  applyConfigChange((c) => {
    const sh = c.machines.find((x) => x.id === m.id)!.shifts.find((s) => s.id === shiftId)
    if (sh) sh.name = v
  })
}
function addShift(m: MachineCfg): void {
  applyConfigChange((c) => {
    c.machines
      .find((x) => x.id === m.id)!
      .shifts.push({ id: uid('sh'), name: '晚班', startMin: 18 * 60, endMin: 21 * 60 })
  })
  toast(`已重排：${m.name} 增加一个班次`, 'good')
}
function removeShift(m: MachineCfg, shiftId: string): void {
  if (m.shifts.length <= 1) {
    toast('每台锯至少保留一个班次', 'bad')
    return
  }
  applyConfigChange((c) => {
    const mm = c.machines.find((x) => x.id === m.id)!
    mm.shifts = mm.shifts.filter((s) => s.id !== shiftId)
  })
  toast(`已重排：${m.name} 删掉一个班次`, 'good')
}
function setSetup(field: 'toolChangeMin' | 'materialChangeMin' | 'thicknessChangeMin' | 'sheetHandlingMin', e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (Number.isNaN(v) || v < 0) {
    toast('等待时间需为非负数字（分钟）', 'bad')
    return
  }
  applyConfigChange((c) => {
    c[field] = v
  })
}
function setHorizon(e: Event): void {
  const v = Math.floor(Number((e.target as HTMLInputElement).value))
  if (!v || v < 1 || v > 14) {
    toast('排产天数取 1~14', 'bad')
    return
  }
  applyConfigChange((c) => {
    c.horizonDays = v
  })
}

function pickStrategy(s: ScheduleStrategy): void {
  setStrategy(s)
}

// ---------------------------------------------------------------------------
// 存档 / 导出

function onArchive(): void {
  const v = archiveCurrent()
  toast(`已存档（${new Date(v.savedAt).toLocaleTimeString('zh-CN')}），共 ${v.result.scheduled.length} 单`, 'good')
}
function onVoid(id: string, exported: boolean): void {
  const tip = exported
    ? '这版已存档且排产表已发出去。作废后：存档里的机台班次与结果作废、策略换到另一条路重排、项目列表交期状态跟着刷新，发出的排产表需追回重发。确定作废？'
    : '作废这版存档并换到另一条策略重排？'
  if (window.confirm(tip)) {
    voidVersion(id)
    toast('已作废并回退重排：策略已切换，全表已按新策略重算', 'good')
  }
}
function exportCsv(): void {
  if (live.value.scheduled.length === 0) {
    toast('当前一个活都没排进来，没有可导出的排产表', 'bad')
    return
  }
  downloadText(`排产表_${live.value.startDay}.csv`, scheduleCsv(live.value, cfg.value), 'text/csv')
  markExported()
  toast('排产表 CSV 已导出（与工单页/打印件同源）', 'good')
}
function doPrintSchedule(): void {
  if (live.value.scheduled.length === 0) {
    toast('当前一个活都没排进来，没有可打印的排产表', 'bad')
    return
  }
  markExported()
  printSchedule()
}
const strategyText = (s: ScheduleStrategy): string => (s === 'rush' ? '急件优先' : '按交期顺排')
const versionLive = (v: { result: Parameters<typeof resultSig>[0]; voidedAt?: number }): boolean =>
  !v.voidedAt && resultSig(v.result) === resultSig(live.value)
</script>

<template>
  <div>
    <!-- 头部：说明 + 操作 -->
    <section class="panel no-print">
      <div class="row wrap">
        <h1 style="font-size: 19px">开料工单排产</h1>
        <span class="tag">{{ cfg.machines.length }} 台锯 · {{ cfg.horizonDays }} 天 · {{ strategyText(cfg.strategy) }}</span>
        <div class="spacer" />
        <button class="sm" @click="exportCsv">⬇ 导出排产表 CSV</button>
        <button class="sm" @click="doPrintSchedule">🖨 打印排产表</button>
        <button class="sm primary" @click="onArchive">存档当前排产</button>
      </div>
      <p class="muted small" style="margin: 8px 0 0">
        工步与刀路同源：每个活的刀数直接取自它的裁切步骤（同规格板的修边刀叠切算一次工步，同一刀向连着排），不另估一套数。
        工时 = 贯通总长 ÷ 机台锯速 + 每张板搬板对位 {{ cfg.sheetHandlingMin }} 分钟，另加机台等待（换刀向 {{ cfg.toolChangeMin }}′ /
        换板种 {{ cfg.materialChangeMin }}′ / 换厚度 {{ cfg.thicknessChangeMin }}′，按实际切换次数计）。
        时间按分钟计、每单占用块向上取整到一刻钟（15 分钟），时刻显示 HH:MM；面积按 mm² 累计、折算 m² 保留 2 位。
        规则：交期早的先上机，每单放进完工最早的机台班次，单不跨班；项目列表页与导出单据用的就是这一份完工时刻。
      </p>
    </section>

    <!-- 横幅：发出的排产表已失效 / 已作废 -->
    <section v-if="exportStale" class="panel banner bad no-print">
      ⚠ 上次导出之后排产又变了（改配置/改交期/重排样都会重算），<b>已发出的排产表已失效</b>，请重新导出并通知车间。
    </section>
    <section v-for="v in voidedExported" :key="'void' + v.id" class="panel banner bad no-print">
      ⚠ 存档 {{ new Date(v.savedAt).toLocaleString('zh-CN') }}（{{ strategyText(v.strategy) }}）已作废：
      其机台班次与完工时刻全部失效，项目列表的交期状态已按新排产刷新；<b>当时发出的排产表需追回作废、按当前排产重发</b>。
    </section>

    <!-- 策略：二选一，取舍写清 -->
    <section class="panel no-print">
      <h3 style="font-size: 14px">排产策略（二选一，切换即整表重排）</h3>
      <div class="strategy-row">
        <label class="strategy" :class="{ active: cfg.strategy === 'due' }">
          <input type="radio" name="strategy" :checked="cfg.strategy === 'due'" @change="pickStrategy('due')" />
          <div>
            <b>按交期顺着做</b>
            <p class="muted small">
              所有单按交期先后上机，整体稳、交期压力均匀；代价是急件只能在队列里等，
              <b>最要紧的那一单可能压线</b>。
            </p>
          </div>
        </label>
        <label class="strategy" :class="{ active: cfg.strategy === 'rush' }">
          <input type="radio" name="strategy" :checked="cfg.strategy === 'rush'" @change="pickStrategy('rush')" />
          <div>
            <b>先插急件</b>
            <p class="muted small">
              勾了「急件」的单插队先上机，把最要紧的单赶出来；代价是排在它后面的几单被推晚，
              <b>可能从赶得上变成赶不上</b>。
            </p>
          </div>
        </label>
      </div>
    </section>

    <!-- 机台与班次配置 -->
    <section class="panel no-print">
      <div class="row wrap">
        <h3 style="font-size: 14px">机台与班次（改任何一项都会整表重排，并逐单列差异）</h3>
        <div class="spacer" />
        <label class="small muted">排产天数
          <input type="number" :value="cfg.horizonDays" min="1" max="14" style="width: 60px; display: inline-block" @change="setHorizon" />
        </label>
        <button class="sm" @click="resetConfig">恢复默认机台参数</button>
      </div>
      <div class="mach-grid">
        <div v-for="m in cfg.machines" :key="m.id" class="mach-box">
          <div class="row">
            <b>{{ m.name }}</b>
            <div class="spacer" />
            <label class="small muted">锯速
              <input type="number" :value="m.cutSpeedMmPerMin" min="1" step="100" style="width: 90px; display: inline-block" @change="setSpeed(m, $event)" />
              mm/min
            </label>
          </div>
          <div v-for="sh in m.shifts" :key="sh.id" class="shift-row">
            <input class="shift-name" :value="sh.name" @change="setShiftName(m, sh.id, $event)" />
            <input type="time" :value="clockOf(sh.startMin)" @change="setShiftTime(m, sh.id, 'startMin', $event)" />
            <span class="muted">~</span>
            <input type="time" :value="clockOf(sh.endMin)" @change="setShiftTime(m, sh.id, 'endMin', $event)" />
            <button class="sm ghost-danger" :disabled="m.shifts.length <= 1" @click="removeShift(m, sh.id)">删</button>
          </div>
          <button class="sm" style="margin-top: 6px" @click="addShift(m)">＋ 加班次</button>
        </div>
        <div class="mach-box">
          <b>机台等待（分钟）</b>
          <label class="field" style="margin-top: 8px"><span>换刀 / 换刀向（竖↔横翻台）</span>
            <input type="number" :value="cfg.toolChangeMin" min="0" @change="setSetup('toolChangeMin', $event)" />
          </label>
          <label class="field"><span>换板种（材质）</span>
            <input type="number" :value="cfg.materialChangeMin" min="0" @change="setSetup('materialChangeMin', $event)" />
          </label>
          <label class="field"><span>换厚度</span>
            <input type="number" :value="cfg.thicknessChangeMin" min="0" @change="setSetup('thicknessChangeMin', $event)" />
          </label>
          <label class="field"><span>搬板对位（每张板）</span>
            <input type="number" :value="cfg.sheetHandlingMin" min="0" step="0.1" @change="setSetup('sheetHandlingMin', $event)" />
          </label>
        </div>
      </div>
    </section>

    <!-- 重排差异 -->
    <section v-if="diff" class="panel diff no-print">
      <div class="row">
        <h3 style="font-size: 14px">本次重排差异（对比改动前）</h3>
        <div class="spacer" />
        <button class="sm" @click="clearDiff">知道了，清除</button>
      </div>
      <p v-if="!diff.machineChanged.length && !diff.timeChanged.length && !diff.rowsChanged.length && !diff.rowsAdded.length && !diff.removedJobs.length" class="muted small">
        排产结果没有变化（改动不影响任何单的机台与完工时刻）。
      </p>
      <div v-else class="diff-cols">
        <div>
          <b class="small">换了机台的单（{{ diff.machineChanged.length }}）</b>
          <ul class="small">
            <li v-for="d in diff.machineChanged" :key="d.jobId">{{ d.jobName }}：{{ d.from }} → {{ d.to }}</li>
            <li v-if="!diff.machineChanged.length" class="muted">无</li>
          </ul>
        </div>
        <div>
          <b class="small">完工时刻变了的单（{{ diff.timeChanged.length }}）</b>
          <ul class="small">
            <li v-for="d in diff.timeChanged" :key="d.jobId">
              {{ d.jobName }}：{{ d.fromText }} → {{ d.toText }}
              （{{ d.deltaMin > 0 ? `推晚 ${d.deltaMin}` : `提前 ${-d.deltaMin}` }} 分钟）
            </li>
            <li v-if="!diff.timeChanged.length" class="muted">无</li>
          </ul>
        </div>
        <div>
          <b class="small">排产表上变了的行</b>
          <ul class="small">
            <li v-if="diff.rowsChanged.length">内容变化：第 {{ diff.rowsChanged.join('、') }} 行</li>
            <li v-if="diff.rowsAdded.length">新增：第 {{ diff.rowsAdded.join('、') }} 行</li>
            <li v-if="diff.removedJobs.length">撤下：{{ diff.removedJobs.join('、') }}</li>
            <li v-if="!diff.rowsChanged.length && !diff.rowsAdded.length && !diff.removedJobs.length" class="muted">无</li>
          </ul>
        </div>
      </div>
    </section>

    <!-- 一个活都没排进来 -->
    <section v-if="live.scheduled.length === 0" class="panel empty-note">
      <h3 style="font-size: 14px">一个活都没排进来，卡在：</h3>
      <ul class="small">
        <li v-if="state.jobs.length === 0">还没有任何项目 —— 先在首页新建项目、录零件并排样。</li>
        <li v-for="s in live.skipped" :key="s.jobId">「{{ s.jobName }}」{{ s.reason }}</li>
        <li v-for="u in live.unscheduled" :key="u.jobId">「{{ u.jobName }}」{{ u.reason }} —— 可加班次、加排产天数或拆单。</li>
      </ul>
    </section>

    <!-- 工单表：按机台与班次列活 -->
    <section v-for="mb in board" :key="mb.machine.id" class="panel machine-panel">
      <div class="row wrap">
        <h3 style="font-size: 14px">{{ mb.machine.name }}</h3>
        <span class="muted small">锯速 {{ mb.machine.cutSpeedMmPerMin }} mm/min</span>
      </div>
      <table class="grid sched-grid">
        <thead>
          <tr>
            <th style="width: 150px">日期 / 班次</th>
            <th style="width: 110px">开工</th>
            <th style="width: 110px">完工</th>
            <th>项目</th>
            <th style="width: 56px">板数</th>
            <th style="width: 76px">工步(刀)</th>
            <th style="width: 76px">面积</th>
            <th style="width: 90px">占用(分钟)</th>
            <th style="width: 92px">交期</th>
            <th style="width: 96px">状态</th>
          </tr>
        </thead>
        <tbody v-for="day in mb.days" :key="day.dayIndex">
          <template v-for="g in day.shifts" :key="g.shift.id">
            <tr class="shift-head">
              <td>
                {{ dayLabel(day.dayIndex) }} {{ day.date }} · {{ g.shift.name }}
                <span class="muted small">{{ clockOf(g.shift.startMin) }}~{{ clockOf(g.shift.endMin) }}</span>
              </td>
              <td colspan="9" class="muted small">
                <template v-if="g.load">
                  负荷 {{ g.load.usedMin }}/{{ g.load.capMin }} 分钟 · {{ g.load.jobs }} 单 · {{ areaM2(g.load.areaMm2) }}
                </template>
                <template v-else>空班（0/{{ g.shift.endMin - g.shift.startMin }} 分钟）</template>
              </td>
            </tr>
            <tr v-for="s in g.jobs" :key="s.jobId" :class="{ overdue: s.overdue }">
              <td></td>
              <td>{{ clockOf(s.startMin) }}</td>
              <td><b>{{ clockOf(s.finishMin) }}</b></td>
              <td>
                <router-link :to="`/nest/${s.jobId}`">{{ s.jobName }}</router-link>
                <span class="muted small" :title="`含机台等待 ${s.setupMin.toFixed(0)} 分钟 + 纯加工 ${s.workMin.toFixed(1)} 分钟`">
                  竖{{ s.vCuts }}刀/横{{ s.hCuts }}刀
                </span>
              </td>
              <td>{{ s.sheets }}</td>
              <td>{{ s.ops }}</td>
              <td>{{ areaM2(s.areaMm2) }}</td>
              <td>{{ s.blockMin }}</td>
              <td>{{ s.dueAt !== undefined ? dateStrOf(s.dueAt) : '未设' }}</td>
              <td>
                <span v-if="s.overdue" class="tag bad">超期</span>
                <span v-else class="tag good">正常</span>
                <span v-if="s.rush" class="tag warn">急件</span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>

    <!-- 排不进 / 未纳入 -->
    <section v-if="live.unscheduled.length" class="panel">
      <h3 style="font-size: 14px">排不进的活（{{ live.unscheduled.length }}）—— 卡在哪</h3>
      <table class="grid" style="margin-top: 8px">
        <thead><tr><th>项目</th><th>板数</th><th>工步(刀)</th><th>原因</th></tr></thead>
        <tbody>
          <tr v-for="u in live.unscheduled" :key="u.jobId">
            <td>{{ u.jobName }}</td>
            <td>{{ u.sheets }}</td>
            <td>{{ u.ops }}</td>
            <td class="small">{{ u.reason }}；可加班次、加排产天数或拆单后重排。</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 交期与急件设置（所有项目） -->
    <section class="panel no-print">
      <h3 style="font-size: 14px">交期与急件（改动即重排，项目列表页跟着刷新）</h3>
      <table class="grid" style="margin-top: 8px">
        <thead>
          <tr><th>项目</th><th style="width: 150px">交期</th><th style="width: 60px">急件</th><th>排产状态（同源）</th></tr>
        </thead>
        <tbody>
          <tr v-for="job in state.jobs" :key="job.id">
            <td>{{ job.name }}</td>
            <td>
              <input type="date" :value="job.dueAt !== undefined ? dateStrOf(job.dueAt) : ''" @change="onDue(job, $event)" />
            </td>
            <td style="text-align: center">
              <input type="checkbox" :checked="job.rush ?? false" @change="onRush(job, $event)" />
            </td>
            <td class="small">
              <template v-if="scheduledByJob.get(job.id)">
                {{ scheduledByJob.get(job.id)!.machineName }} · {{ scheduledByJob.get(job.id)!.date }}
                {{ scheduledByJob.get(job.id)!.shiftName }} · 完工 {{ clockOf(scheduledByJob.get(job.id)!.finishMin) }}
                <span v-if="scheduledByJob.get(job.id)!.overdue" class="tag bad">超期</span>
              </template>
              <span v-else-if="unscheduledByJob.get(job.id)" class="tag bad">排不进</span>
              <span v-else-if="skippedByJob.get(job.id)" class="muted">{{ skippedByJob.get(job.id)!.reason }}</span>
            </td>
          </tr>
          <tr v-if="state.jobs.length === 0"><td colspan="4" class="muted">还没有项目。</td></tr>
        </tbody>
      </table>
    </section>

    <!-- 存档 -->
    <section class="panel no-print">
      <h3 style="font-size: 14px">本机存档（{{ schedState.versions.length }}）</h3>
      <p class="muted small" style="margin: 4px 0 8px">
        存档记录当时的机台班次配置与整表完工时刻；选错策略的那版可「作废并回退重排」——作废后策略换到另一条路，
        存档、项目列表交期状态与已发出的排产表一并失效。
      </p>
      <table class="grid">
        <thead>
          <tr><th>存档时间</th><th>策略</th><th>机台/班次</th><th>已排单数</th><th>状态</th><th style="width: 150px">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="v in schedState.versions" :key="v.id" :class="{ voided: !!v.voidedAt }">
            <td>{{ new Date(v.savedAt).toLocaleString('zh-CN') }}</td>
            <td>{{ strategyText(v.strategy) }}</td>
            <td class="small">
              {{ v.config.machines.map((m) => `${m.name}(${m.shifts.length}班)`).join(' + ') }} · {{ v.config.horizonDays }}天
            </td>
            <td>{{ v.result.scheduled.length }}</td>
            <td>
              <span v-if="v.voidedAt" class="tag bad">已作废</span>
              <span v-else-if="versionLive(v)" class="tag good">当前生效</span>
              <span v-else class="tag">历史</span>
              <span v-if="v.exportedAt" class="tag warn">已导出</span>
            </td>
            <td>
              <button v-if="!v.voidedAt" class="sm ghost-danger" @click="onVoid(v.id, !!v.exportedAt)">
                作废并回退重排
              </button>
            </td>
          </tr>
          <tr v-if="schedState.versions.length === 0"><td colspan="6" class="muted">还没有存档。点右上角「存档当前排产」留一版。</td></tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.banner {
  margin-top: 12px;
  font-size: 13px;
}
.banner.bad {
  border-color: #eecfcf;
  background: var(--c-bad-bg);
  color: var(--c-bad);
}
.strategy-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 10px;
}
.strategy {
  display: flex;
  gap: 10px;
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  align-items: flex-start;
}
.strategy.active {
  border-color: var(--c-primary);
  background: #fffbf3;
}
.strategy p {
  margin: 4px 0 0;
}
.strategy input {
  margin-top: 3px;
  width: auto;
}
.mach-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  margin-top: 10px;
}
.mach-box {
  border: 1px solid var(--c-line-soft);
  border-radius: 8px;
  padding: 10px 12px;
}
.shift-row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 6px;
}
.shift-row input[type='time'] {
  width: 96px;
}
.shift-name {
  width: 64px;
}
.diff {
  border-color: #f0d9b5;
  background: #fffdf6;
}
.diff-cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
  margin-top: 8px;
}
.diff-cols ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.machine-panel {
  margin-top: 14px;
}
.sched-grid {
  margin-top: 8px;
}
.shift-head td {
  background: #eef2ee !important;
  font-weight: 600;
}
tr.overdue td {
  background: #fff5f5 !important;
}
.empty-note {
  margin-top: 14px;
  border-color: #f0d9b5;
  background: #fffdf6;
}
.empty-note ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
tr.voided td {
  opacity: 0.55;
  text-decoration: line-through;
}
tr.voided td:last-child {
  text-decoration: none;
}
section + section {
  margin-top: 14px;
}
.machine-panel + .machine-panel {
  margin-top: 14px;
}
</style>
