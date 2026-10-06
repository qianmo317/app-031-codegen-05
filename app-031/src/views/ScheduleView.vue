<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useStore } from '../lib/store'
import {
  useScheduleStore,
  previewSchedule,
  publishSchedule,
  voidPublished,
  markExported,
  setPolicy,
  setHorizonStart,
  updateMachine,
  addShift,
  updateShift,
  removeShift,
  updateParams,
  updateSetup
} from '../lib/scheduleStore'
import {
  fmtClock,
  fmtDur,
  fmtDue,
  policyDescription,
  scheduleToCsv,
  toM2
} from '../lib/schedule'
import { downloadText } from '../lib/format'
import { toast } from '../lib/ui'
import type { ScheduleVersion } from '../types'
import { printSchedule } from '../lib/printSchedule'

const router = useRouter()
const { state } = useStore()
const { ss, currentVersion, lastVoided } = useScheduleStore()

const preview = computed(() => previewSchedule(state.jobs))
const version = computed<ScheduleVersion>(() => preview.value.version)
const cur = currentVersion
const diff = computed(() => preview.value.diff)
const stale = computed(() => preview.value.stale)
const staleJobs = computed(() => preview.value.staleJobs)
const configChanged = computed(() => preview.value.configChanged)

const showSettings = ref(false)
const justPublished = ref<{ diff: ReturnType<typeof previewSchedule>['diff'] } | null>(null)
const rollbackMsg = ref<string | null>(null)

const nestableJobs = computed(() => state.jobs.filter((j) => j.result && j.result.unplaced.length === 0))

const machines = computed(() => ss.cfg.machines)
const shifts = computed(() => ss.cfg.shifts)

// ── 班次时间展示 ─────────────────────────────────────────────────────────────
function fmtHM(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${`${h}`.padStart(2, '0')}:${`${m}`.padStart(2, '0')}`
}
function parseHM(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

// ── 操作 ─────────────────────────────────────────────────────────────────────
function choosePolicy(p: 'urgent-first' | 'edd'): void {
  setPolicy(p)
}
function onPublish(): void {
  const hadPublished = cur.value
  const { version: v, diff: d, voided } = publishSchedule(state.jobs)
  justPublished.value = { diff: d }
  if (voided) {
    toast(
      voided.exported
        ? `已发布新版，旧版（${voided.id.slice(-6)}，已导出）已作废，记得撤回旧排产表`
        : '已发布新版，旧版本已作废',
      'good'
    )
  } else {
    toast('排产表已发布到本机存档，工单页/项目列表/导出已同步', 'good')
  }
  void hadPublished
  void v
}
function onVoid(): void {
  const cur0 = cur.value
  if (!cur0) return
  const other = cur0.policy === 'urgent-first' ? '按交期顺做' : '先插急件'
  if (
    !window.confirm(
      `确认作废当前${cur0.exported ? '并已导出的' : ''}排产表（${cur0.id.slice(-6)}）？\n` +
        `作废后工单页机台班次、项目列表交期状态、导出的排产表全部回退到「待重排」。\n` +
        `请改走「${other}」（或调机速/加班次）后重新排产发布。`
    )
  )
    return
  const r = voidPublished()
  if (r) {
    rollbackMsg.value = r.needRecall
      ? `已作废的版本曾导出/打印发出：请通知车间撤回旧排产表（版本 ${r.voided.id.slice(-6)}），并重排后重新下发。`
      : '当前版本已作废，三处页面已回退；请换一条策略或调整机台/班次后重新排产。'
    toast('版本已作废，请重排', 'bad')
  }
}
function onExportCsv(): void {
  // 导出走"已发布生效版本"；若当前配置有未发布变更，先要求发布，保证三处同源
  if (!cur.value) {
    toast('还没有已发布的排产表，先排产并发布', 'bad')
    return
  }
  if (configChanged.value || stale.value) {
    if (!window.confirm('排产设置或刀路相对已发布版本有改动，导出的将是旧版。先去发布新版再导出吗？')) return
    return
  }
  const safe = cur.value.horizonStartDate
  downloadText(`开料排产表_${safe}_${cur.value.id.slice(-6)}.csv`, scheduleToCsv(cur.value), 'text/csv')
  markExported(cur.value.id)
  toast('排产表 CSV 已导出，并标记为已发出', 'good')
}
function onPrint(): void {
  if (!cur.value) {
    toast('还没有已发布的排产表，先排产并发布', 'bad')
    return
  }
  printSchedule(cur.value.id)
  markExported(cur.value.id)
}

function openJob(id: string): void {
  router.push(`/schedule/job/${id}`)
}

const totalM2 = computed(() => toM2(version.value.totalAreaMm2))
const lateJobs = computed(() => version.value.jobs.filter((j) => j.late))
const rowsByMachine = computed(() => {
  const map = new Map<string, typeof version.value.rows>()
  for (const r of version.value.rows) {
    const arr = map.get(r.machineId) ?? []
    arr.push(r)
    map.set(r.machineId, arr)
  }
  return [...map.entries()].map(([id, rows]) => ({
    id,
    name: machines.value.find((m) => m.id === id)?.name ?? id,
    rows
  }))
})

// 供模板判断该行是否相对已发布版变化（diff 已在 row.changed 打点）
function isRowChanged(rowId: string): boolean {
  return !!version.value.rows.find((r) => r.rowId === rowId)?.changed
}
void isRowChanged
void lastVoided
</script>

<template>
  <div>
    <section class="panel">
      <div class="row wrap">
        <h1 style="font-size: 19px">开料工单排产</h1>
        <span class="tag">两台锯 · 按班次倒交期排程 · 工步刀数取自刀路</span>
        <div class="spacer" />
        <button class="sm" @click="showSettings = !showSettings">
          {{ showSettings ? '收起' : '机台/班次/工时设置' }}
        </button>
      </div>

      <!-- 策略二选一 -->
      <div class="policy-box">
        <div
          :class="['policy-card', ss.cfg.policy === 'urgent-first' ? 'on' : '']"
          @click="choosePolicy('urgent-first')"
        >
          <b>① 先插急件</b>
          <p class="small muted">{{ policyDescription('urgent-first') }}</p>
        </div>
        <div
          :class="['policy-card', ss.cfg.policy === 'edd' ? 'on' : '']"
          @click="choosePolicy('edd')"
        >
          <b>② 按交期顺做</b>
          <p class="small muted">{{ policyDescription('edd') }}</p>
        </div>
      </div>

      <div class="row wrap" style="margin-top: 10px; gap: 16px">
        <label class="field" style="margin: 0">
          <span>排产起始日（早班从这天 08:00 起算）</span>
          <input
            type="date"
            :value="ss.cfg.horizonStartDate"
            style="width: 160px"
            @input="setHorizonStart(($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="field" style="margin: 0">
          <span>排产天数上限</span>
          <input
            type="number"
            min="1"
            max="30"
            :value="ss.cfg.params.horizonDays"
            style="width: 90px"
            @input="updateParams({ horizonDays: Math.max(1, Number(($event.target as HTMLInputElement).value) || 1) })"
          />
        </label>
        <div class="spacer" />
        <button class="primary" @click="onPublish">
          {{ cur ? '重算并发布新版（旧版自动作废）' : '排产并发布' }}
        </button>
        <button @click="onExportCsv">导出排产表 CSV</button>
        <button @click="onPrint">🖨 打印排产表</button>
        <button v-if="cur" class="ghost-danger" @click="onVoid">作废并回退重排</button>
      </div>

      <!-- 当前版本状态条 -->
      <div v-if="cur" class="row wrap ver-bar">
        <span :class="['tag', cur.status === 'voided' ? 'bad' : 'good']">
          生效版本 {{ cur.id.slice(-6) }} · {{ cur.policy === 'urgent-first' ? '先插急件' : '按交期顺做' }}
        </span>
        <span class="tag">{{ cur.exported ? '排产表已导出/打印发出' : '仅本机存档' }}</span>
        <span class="tag">发布于 {{ new Date(cur.createdAt).toLocaleString('zh-CN') }}</span>
        <div class="spacer" />
        <span v-if="configChanged || stale" class="tag bad">
          ⚠ 当前设置/刀路相对生效版本已改动，需重新发布
        </span>
      </div>
      <div v-if="rollbackMsg" class="panel warn-box">
        {{ rollbackMsg }}
        <button class="sm" style="margin-left: 10px" @click="rollbackMsg = null">知道了</button>
      </div>
      <p v-if="stale" class="bad small" style="margin: 8px 0 0">
        ⚠ 刀路/交期输入已变，生效排产表过期：{{ staleJobs.join('、') }}。重新发布会按新刀路的刀数算工时。
      </p>
    </section>

    <!-- 设置面板 -->
    <section v-if="showSettings" class="panel" style="margin-top: 14px">
      <h3 style="font-size: 14px">机台（车间只有两台锯；速度改完整张表要重排）</h3>
      <table class="grid" style="margin: 8px 0">
        <thead>
          <tr><th>机台</th><th style="width: 220px">相对速度</th><th>开通班次</th></tr>
        </thead>
        <tbody>
          <tr v-for="m in machines" :key="m.id">
            <td>
              <input :value="m.name" style="width: 120px"
                @input="updateMachine(m.id, { name: ($event.target as HTMLInputElement).value })" />
            </td>
            <td>
              <div class="row">
                <input type="range" min="0.7" max="1.6" step="0.05" :value="m.speedFactor"
                  @input="updateMachine(m.id, { speedFactor: Number(($event.target as HTMLInputElement).value) })" />
                <b style="width: 52px">{{ m.speedFactor.toFixed(2) }}×</b>
              </div>
            </td>
            <td>
              <div class="row wrap">
                <label v-for="sh in shifts" :key="sh.id" class="row small" style="gap: 4px">
                  <input type="checkbox" :checked="m.shiftIds.includes(sh.id)"
                    @change="updateMachine(m.id, {
                      shiftIds: ($event.target as HTMLInputElement).checked
                        ? [...m.shiftIds, sh.id]
                        : m.shiftIds.filter((x) => x !== sh.id)
                    })" />
                  {{ sh.name }}
                </label>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <h3 style="font-size: 14px; margin-top: 12px">班次（加一个班次要整表重排）</h3>
      <table class="grid" style="margin: 8px 0">
        <thead>
          <tr><th>名称</th><th>上班</th><th>下班</th><th style="width: 120px"></th></tr>
        </thead>
        <tbody>
          <tr v-for="sh in shifts" :key="sh.id">
            <td>
              <input :value="sh.name" style="width: 110px"
                @input="updateShift(sh.id, { name: ($event.target as HTMLInputElement).value })" />
            </td>
            <td>
              <input type="time" :value="fmtHM(sh.startMin)" style="width: 120px"
                @input="updateShift(sh.id, { startMin: parseHM(($event.target as HTMLInputElement).value) })" />
            </td>
            <td>
              <input type="time" :value="fmtHM(sh.endMin)" style="width: 120px"
                @input="updateShift(sh.id, { endMin: parseHM(($event.target as HTMLInputElement).value) })" />
            </td>
            <td>
              <button class="sm ghost-danger" @click="removeShift(sh.id)">删除班次</button>
            </td>
          </tr>
        </tbody>
      </table>
      <button class="sm" @click="addShift()">＋ 加一个班次（默认晚班 18:00–22:00，记得勾到机台上）</button>

      <h3 style="font-size: 14px; margin-top: 14px">换型等待（整数分钟，不取整）</h3>
      <div class="row wrap" style="gap: 18px; margin-top: 6px">
        <label class="field" style="margin: 0"><span>换刀向（横↔竖）</span>
          <input type="number" min="0" :value="ss.cfg.params.setup.blade" style="width: 90px"
            @input="updateSetup({ blade: Number(($event.target as HTMLInputElement).value) || 0 })" /></label>
        <label class="field" style="margin: 0"><span>换板种（材质）</span>
          <input type="number" min="0" :value="ss.cfg.params.setup.material" style="width: 90px"
            @input="updateSetup({ material: Number(($event.target as HTMLInputElement).value) || 0 })" /></label>
        <label class="field" style="margin: 0"><span>换厚度</span>
          <input type="number" min="0" :value="ss.cfg.params.setup.thickness" style="width: 90px"
            @input="updateSetup({ thickness: Number(($event.target as HTMLInputElement).value) || 0 })" /></label>
      </div>

      <h3 style="font-size: 14px; margin-top: 14px">工时估算（加工时长 = 板数×搬运 + 刀数×刀时，再向上取整 15 分钟）</h3>
      <div class="row wrap" style="gap: 18px; margin-top: 6px">
        <label class="field" style="margin: 0"><span>每刀秒数（刀路 1 刀）</span>
          <input type="number" min="5" step="5" :value="ss.cfg.params.cutSecondsPerBlade" style="width: 90px"
            @input="updateParams({ cutSecondsPerBlade: Number(($event.target as HTMLInputElement).value) || 45 })" /></label>
        <label class="field" style="margin: 0"><span>每张板搬运秒数</span>
          <input type="number" min="0" step="5" :value="ss.cfg.params.handleSecondsPerBoard" style="width: 90px"
            @input="updateParams({ handleSecondsPerBoard: Number(($event.target as HTMLInputElement).value) || 0 })" /></label>
      </div>
      <p class="small muted" style="margin: 8px 0 0">
        精度约定：内部时间按整数分钟推进；每个加工工步时长向上取整到一刻钟（15 分钟）；换型等待为整数分钟不取整；
        完工时刻统一按一刻钟口径与交期比较。面积内部用平方毫米（整数），展示折平方米保留 2 位小数。
      </p>
    </section>

    <!-- 重排差异（改机速/加班次后逐单点名） -->
    <section v-if="cur && (diff.machineChanged.length || diff.finishChanged.length || diff.rowsChanged || diff.newLate.length || diff.rescued.length)"
      class="panel diff-box" style="margin-top: 14px">
      <h3 style="font-size: 14px">本次重排相对生效版本的变化（发布后生效）</h3>
      <div class="row wrap" style="gap: 8px; margin: 8px 0">
        <span class="tag">换了机台：{{ diff.machineChanged.length }} 单</span>
        <span class="tag">完工时刻变了：{{ diff.finishChanged.length }} 单</span>
        <span class="tag">排产表变化行：{{ diff.rowsChanged }}（新增 {{ diff.rowsAdded }} / 删除 {{ diff.rowsRemoved }}）</span>
        <span class="tag bad" v-if="diff.newLate.length">新赶不上交期：{{ diff.newLate.map((x) => x.jobName).join('、') }}</span>
        <span class="tag good" v-if="diff.rescued.length">被救回：{{ diff.rescued.map((x) => x.jobName).join('、') }}</span>
      </div>
      <table v-if="diff.machineChanged.length || diff.finishChanged.length" class="grid">
        <thead><tr><th>单</th><th>换机台</th><th>完工时刻（旧 → 新，一刻钟口径）</th></tr></thead>
        <tbody>
          <tr v-for="mc in diff.machineChanged" :key="'m' + mc.jobId">
            <td>{{ mc.jobName }}</td><td>{{ mc.from }} → {{ mc.to }}</td>
            <td>{{ (diff.finishChanged.find((f) => f.jobId === mc.jobId)
              ? fmtClock(diff.finishChanged.find((f) => f.jobId === mc.jobId)!.fromMin) + ' → ' + fmtClock(diff.finishChanged.find((f) => f.jobId === mc.jobId)!.toMin)
              : '不变') }}</td>
          </tr>
          <tr v-for="fc in diff.finishChanged.filter((f) => !diff.machineChanged.some((m) => m.jobId === f.jobId))" :key="'f' + fc.jobId">
            <td>{{ fc.jobName }}</td><td>—</td><td>{{ fmtClock(fc.fromMin) }} → {{ fmtClock(fc.toMin) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 汇总 -->
    <section class="panel kpi-row" style="margin-top: 14px">
      <div><b>{{ version.jobs.length }}</b><span>排入的单</span></div>
      <div><b>{{ version.rows.filter((r) => r.op.kind !== 'setup').length }}</b><span>工步（修边/裁切）</span></div>
      <div><b>{{ totalM2.toFixed(2) }}</b><span>加工面积 m²（mm² 折算，2 位小数）</span></div>
      <div :class="{ bad: lateJobs.length > 0 }"><b>{{ lateJobs.length }}</b><span>赶不上交期的单</span></div>
      <div><b>{{ version.unscheduled.length }}</b><span>排不进来的单</span></div>
    </section>

    <!-- 赶不上交期的单（点名） -->
    <section v-if="lateJobs.length" class="panel" style="margin-top: 14px; border-color: #e0a3a3">
      <h3 style="font-size: 14px; color: var(--c-bad)">⚠ 赶不上交期（{{ lateJobs.length }} 单，按一刻钟完工口径）</h3>
      <table class="grid" style="margin-top: 8px">
        <thead><tr><th>项目</th><th>机台</th><th>完工时刻</th><th>交期</th><th>晚多少</th></tr></thead>
        <tbody>
          <tr v-for="j in lateJobs" :key="j.jobId" style="cursor: pointer" @click="openJob(j.jobId)">
            <td>{{ j.jobName }}</td><td>{{ j.machineName }}</td>
            <td>{{ fmtClock(j.finishQuarterMin) }}</td><td>{{ fmtDue(j.dueAt) }}</td>
            <td class="bad">晚 {{ fmtDur(j.lateMin) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 排不进来：卡在哪 -->
    <section v-if="version.unscheduled.length" class="panel" style="margin-top: 14px; border-color: #f0d9b5">
      <h3 style="font-size: 14px">排不进来 / 一个活都没排进来时卡在哪</h3>
      <table class="grid" style="margin-top: 8px">
        <thead><tr><th>项目</th><th style="width: 200px">卡点</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="u in version.unscheduled" :key="u.jobId">
            <td>{{ u.jobName }}</td><td><span class="tag warn">{{ u.reason }}</span></td><td class="small muted">{{ u.detail }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 工单页式排产表：按机台与班次列活（预览即当前配置重算结果；发布后与存档一致） -->
    <section v-for="grp in rowsByMachine" :key="grp.id" class="panel" style="margin-top: 14px">
      <h3 style="font-size: 14px; margin-bottom: 8px">{{ grp.name }} · 工步序列（同刀向连续、叠切算一步）</h3>
      <table class="grid sched-table">
        <thead>
          <tr>
            <th>天</th><th>班次</th><th>开始</th><th>结束</th><th>项目</th><th>工步</th>
            <th>板规格</th><th>叠切</th><th>刀数（刀路）</th><th>刀向</th><th>时长</th><th>等待</th><th>刀路出处</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in grp.rows" :key="r.rowId">
            <tr v-if="r.op.kind === 'setup'" class="setup-row">
              <td>{{ r.dayIndex + 1 }}</td><td>{{ r.shiftName }}</td>
              <td>{{ fmtHM(r.startMin % 1440) }}</td><td>{{ fmtHM(r.endMin % 1440) }}</td>
              <td colspan="8">⏸ {{ (r.reasons ?? []).join('、') }} 等待</td>
              <td>{{ r.endMin - r.startMin }} 分</td>
              <td></td>
            </tr>
            <tr v-else :class="{ 'changed-row': r.changed }">
              <td>第{{ r.dayIndex + 1 }}天</td>
              <td>{{ r.shiftName }}</td>
              <td>{{ fmtHM(r.startMin % 1440) }}</td>
              <td>{{ fmtHM(r.endMin % 1440) }}</td>
              <td><a @click="openJob(r.op.jobId)">{{ r.op.jobName }}</a></td>
              <td>{{ r.op.kind === 'trim' ? '修边叠切' : '内部刀裁切' }}</td>
              <td class="small">{{ r.op.boardDesc }}</td>
              <td>{{ r.op.stackSheets }} 张</td>
              <td><b>{{ r.op.bladeCount }}</b> 刀</td>
              <td>{{ r.op.axis === 'v' ? '竖' : '横' }}</td>
              <td>{{ fmtDur(r.op.workMin) }}</td>
              <td>{{ r.op.setupMin ? r.op.setupMin + ' 分' : '' }}</td>
              <td class="small muted">
                <span v-for="(s, i) in r.op.source" :key="i">
                  板{{ s.sheetIndex + 1 }}刀{{ s.orderFrom + 1 }}<template v-if="s.orderTo > s.orderFrom">~{{ s.orderTo + 1 }}</template><template v-if="i < r.op.source.length - 1">；</template>
                </span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>

    <!-- 每单完工时刻（同源清单） -->
    <section class="panel" style="margin-top: 14px">
      <h3 style="font-size: 14px; margin-bottom: 8px">每单完工时刻（工单页 / 项目列表页 / 导出打印三处同源）</h3>
      <table class="grid">
        <thead>
          <tr><th>项目</th><th>机台</th><th>开工</th><th>完工（一刻钟口径）</th><th>交期</th><th>状态</th><th>加工</th><th>等待</th><th>面积 m²</th></tr>
        </thead>
        <tbody>
          <tr v-for="j in version.jobs" :key="j.jobId" :class="{ 'changed-row': j.changed, 'late-row': j.late }">
            <td><a @click="openJob(j.jobId)">{{ j.jobName }}</a></td>
            <td>{{ j.machineName }}</td>
            <td>{{ fmtClock(j.startMin) }}</td>
            <td><b>{{ fmtClock(j.finishQuarterMin) }}</b></td>
            <td>{{ fmtDue(j.dueAt) }}</td>
            <td><span :class="['tag', j.late ? 'bad' : 'good']">{{ j.late ? `赶不上（晚 ${fmtDur(j.lateMin)}）` : '赶得上' }}</span></td>
            <td>{{ fmtDur(j.workMin) }}</td>
            <td>{{ j.setupMin }} 分</td>
            <td>{{ toM2(j.areaMm2).toFixed(2) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="small muted" style="margin: 8px 0 0">{{ version.notes }}</p>
      <p v-if="nestableJobs.length === 0" class="small muted" style="margin: 8px 0 0">
        一个活都没排进来：当前没有任何已排样成功（且无未排下零件）的项目。先到项目里录零件并排样，刀路出来后这里才能按刀数排产。
      </p>
    </section>
  </div>
</template>

<style scoped>
.policy-box {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 12px;
}
.policy-card {
  border: 1.5px solid var(--c-line);
  border-radius: 8px;
  padding: 10px 14px;
  cursor: pointer;
  background: #fafcf9;
}
.policy-card.on {
  border-color: var(--c-primary);
  background: #fff7ed;
  box-shadow: inset 0 0 0 1px var(--c-primary);
}
.policy-card p {
  margin: 6px 0 0;
}
.ver-bar {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--c-line);
}
.warn-box {
  margin-top: 10px;
  background: #fffbeb;
  border-color: #f0d9b5;
  padding: 10px 14px;
}
.kpi-row {
  display: flex;
  gap: 10px;
}
.kpi-row > div {
  flex: 1;
  background: #f4f7f3;
  border-radius: 6px;
  padding: 10px;
  text-align: center;
}
.kpi-row b {
  display: block;
  font-size: 20px;
}
.kpi-row span {
  font-size: 11px;
  color: var(--c-ink-2);
}
.kpi-row .bad b {
  color: var(--c-bad);
}
.diff-box {
  background: #fbfcfb;
}
.sched-table {
  font-size: 12px;
}
.sched-table th,
.sched-table td {
  padding: 4px 7px;
  white-space: nowrap;
}
.setup-row td {
  background: #f3f0e8 !important;
  color: var(--c-warn);
}
.changed-row td {
  background: #fff7ed !important;
}
.late-row td {
  background: var(--c-bad-bg) !important;
}
@media (max-width: 900px) {
  .policy-box {
    grid-template-columns: 1fr;
  }
}
</style>
