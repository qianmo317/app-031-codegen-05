<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { getJob, useStore, setJobScheduleFields } from '../lib/store'
import {
  useScheduleStore,
  previewSchedule,
  currentVersion
} from '../lib/scheduleStore'
import { fmtClock, fmtDur, fmtDue, toM2, dueAtFromDate } from '../lib/schedule'
import { toast } from '../lib/ui'

const route = useRoute()
const { state } = useStore()
const job = computed(() => getJob(route.params.id as string))
useScheduleStore()
const version = computed(() => currentVersion.value)
// 排产是全局的：预览也拿全部活重算，再取本单
const previewAll = computed(() => previewSchedule(state.jobs).version)
const previewJob = computed(() => previewAll.value.jobs.find((j) => j.jobId === route.params.id))

// 该单在生效版本里的工步行（按机台与班次列活）
const liveRows = computed(() =>
  version.value?.rows.filter((r) => r.op.jobId === route.params.id) ?? []
)
const liveJob = computed(() => version.value?.jobs.find((j) => j.jobId === route.params.id))

function fmtHM(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${`${h}`.padStart(2, '0')}:${`${m}`.padStart(2, '0')}`
}

function onDue(e: Event): void {
  if (!job.value) return
  const v = (e.target as HTMLInputElement).value
  setJobScheduleFields(job.value, { dueAt: v ? dueAtFromDate(v) : null })
  toast('交期已改，排产表需重新发布才会刷新完工时刻', 'info')
}
function toggleUrgent(): void {
  if (!job.value) return
  setJobScheduleFields(job.value, { urgent: !job.value.urgent })
  toast(job.value.urgent ? '已标为急件（先插急件策略下插队）' : '已取消急件', 'info')
}

const dueDateValue = computed(() => {
  if (!job.value?.dueAt) return ''
  const d = new Date(job.value.dueAt)
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
})
</script>

<template>
  <div v-if="job">
    <section class="panel">
      <div class="row wrap">
        <h1 style="font-size: 18px">开料工单 · {{ job.name }}</h1>
        <span v-if="job.urgent" class="tag bad">急件</span>
        <div class="spacer" />
        <router-link to="/schedule">← 回排产总表</router-link>
      </div>
      <div class="row wrap" style="margin-top: 12px; gap: 18px">
        <label class="field" style="margin: 0">
          <span>交期（默认当日 18:00 下班点）</span>
          <input type="date" :value="dueDateValue" style="width: 160px" @input="onDue" />
        </label>
        <button class="sm" :class="job.urgent ? 'ghost-danger' : ''" @click="toggleUrgent">
          {{ job.urgent ? '取消急件标记' : '标为急件' }}
        </button>
      </div>
      <p v-if="!job.result" class="small muted" style="margin-top: 10px">
        该单还没排样：排产工步的刀数来自排样刀路，先去
        <router-link :to="`/nest/${job.id}`">排样页</router-link>算出刀路。
      </p>
    </section>

    <!-- 生效版本里的完工时刻（与项目列表页、导出表同源） -->
    <section v-if="liveJob" class="panel" style="margin-top: 14px">
      <div class="row wrap" style="gap: 14px">
        <div class="status-card">
          <span>机台</span><b>{{ liveJob.machineName }}</b>
        </div>
        <div class="status-card">
          <span>开工</span><b>{{ fmtClock(liveJob.startMin) }}</b>
        </div>
        <div class="status-card" :class="{ bad: liveJob.late }">
          <span>完工（一刻钟口径）</span><b>{{ fmtClock(liveJob.finishQuarterMin) }}</b>
        </div>
        <div class="status-card">
          <span>交期</span><b>{{ fmtDue(liveJob.dueAt) }}</b>
        </div>
        <div class="status-card" :class="{ bad: liveJob.late, good: !liveJob.late }">
          <span>状态</span>
          <b>{{ liveJob.late ? `赶不上，晚 ${fmtDur(liveJob.lateMin)}` : '赶得上' }}</b>
        </div>
        <div class="status-card">
          <span>加工 / 等待</span><b>{{ fmtDur(liveJob.workMin) }} / {{ liveJob.setupMin }} 分</b>
        </div>
        <div class="status-card">
          <span>加工面积</span><b>{{ toM2(liveJob.areaMm2).toFixed(2) }} m²</b>
        </div>
      </div>
      <p v-if="version?.exported" class="small muted" style="margin: 10px 0 0">
        当前版本的排产表已导出/打印发出。重排发布后旧表作废，需以新版本重新下发。
      </p>
    </section>

    <section v-else class="panel" style="margin-top: 14px">
      <p class="muted">该单还不在生效排产表里（未发布或排不进来）。</p>
      <router-link to="/schedule"><button class="primary sm">去排产总表</button></router-link>
    </section>

    <!-- 按机台与班次列本单的活（生效版本） -->
    <section v-if="liveRows.length" class="panel" style="margin-top: 14px">
      <h3 style="font-size: 14px; margin-bottom: 8px">本机台班次上的活（生效版本）</h3>
      <table class="grid sched-table">
        <thead>
          <tr>
            <th>天</th><th>班次</th><th>开始</th><th>结束</th><th>工步</th>
            <th>板规格</th><th>叠切</th><th>刀数（刀路同源）</th><th>刀向</th><th>时长</th><th>刀路出处</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in liveRows" :key="r.rowId">
            <tr v-if="r.op.kind === 'setup'" class="setup-row">
              <td>{{ r.dayIndex + 1 }}</td><td>{{ r.shiftName }}</td>
              <td>{{ fmtHM(r.startMin % 1440) }}</td><td>{{ fmtHM(r.endMin % 1440) }}</td>
              <td colspan="6">⏸ {{ (r.reasons ?? []).join('、') }} 等待 {{ r.endMin - r.startMin }} 分钟</td>
              <td></td>
            </tr>            <tr v-else>
              <td>第{{ r.dayIndex + 1 }}天</td>
              <td>{{ r.shiftName }}</td>
              <td>{{ fmtHM(r.startMin % 1440) }}</td>
              <td>{{ fmtHM(r.endMin % 1440) }}</td>
              <td>{{ r.op.kind === 'trim' ? '修边叠切' : '内部刀裁切' }}</td>
              <td class="small">{{ r.op.boardDesc }}</td>
              <td>{{ r.op.stackSheets }} 张</td>
              <td><b>{{ r.op.bladeCount }}</b> 刀</td>
              <td>{{ r.op.axis === 'v' ? '竖' : '横' }}</td>
              <td>{{ fmtDur(r.op.workMin) }}</td>
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

    <!-- 未发布改动预览 -->
    <section v-if="previewJob" class="panel" style="margin-top: 14px">
      <h3 style="font-size: 14px; margin-bottom: 4px">当前设置下的重算预览（未发布）</h3>
      <p class="small muted" style="margin: 0 0 8px">
        改了机速/班次/交期/急件但还没发布时，这里能看到新结果；发布后项目列表页与导出表会一起刷新。
      </p>
      <p class="small">
        预览完工（一刻钟口径）：
        <b>{{ fmtClock(previewJob.finishQuarterMin) }}</b>
        ，机台 {{ previewJob.machineName }}
        ，<span :style="previewJob.late ? 'color:var(--c-bad)' : 'color:var(--c-good)'">
          {{ previewJob.late ? `赶不上，晚 ${fmtDur(previewJob.lateMin)}` : '赶得上' }}
        </span>
      </p>
    </section>
  </div>
</template>

<style scoped>
.status-card {
  background: #f4f7f3;
  border-radius: 6px;
  padding: 8px 14px;
  min-width: 130px;
}
.status-card span {
  display: block;
  font-size: 11px;
  color: var(--c-ink-2);
}
.status-card b {
  font-size: 15px;
}
.status-card.bad {
  background: var(--c-bad-bg);
}
.status-card.bad b {
  color: var(--c-bad);
}
.status-card.good b {
  color: var(--c-good);
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
</style>
