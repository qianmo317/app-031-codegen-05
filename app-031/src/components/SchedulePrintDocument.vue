<script setup lang="ts">
import { computed } from 'vue'
import { schedulePrintState } from '../lib/printSchedule'
import { useScheduleStore } from '../lib/scheduleStore'
import { fmtClock, fmtDur, fmtDue, toM2 } from '../lib/schedule'

const { currentVersion } = useScheduleStore()
const version = computed(() =>
  schedulePrintState.versionId
    ? currentVersion.value?.id === schedulePrintState.versionId
      ? currentVersion.value
      : undefined
    : undefined
)

function fmtHM(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${`${h}`.padStart(2, '0')}:${`${m}`.padStart(2, '0')}`
}

const rowsByMachine = computed(() => {
  const v = version.value
  if (!v) return []
  const map = new Map<string, typeof v.rows>()
  for (const r of v.rows) {
    const arr = map.get(r.machineId) ?? []
    arr.push(r)
    map.set(r.machineId, arr)
  }
  return [...map.entries()].map(([id, rows]) => ({
    id,
    name: v.machines.find((m) => m.id === id)?.name ?? id,
    rows
  }))
})
</script>

<template>
  <div v-if="version" class="print-doc print-only">
    <!-- 排产表：按机台与班次 -->
    <section v-for="grp in rowsByMachine" :key="grp.id" class="print-page">
      <h2>开料工单排产表 · {{ grp.name }}</h2>
      <p class="doc-meta">
        版本 {{ version.id.slice(-6) }}（{{ version.status === 'voided' ? '已作废' : '已发布' }}{{ version.exported ? '·已发出' : '' }}）
        ｜ 策略：{{ version.policy === 'urgent-first' ? '先插急件' : '按交期顺做' }}
        ｜ 排产起始 {{ version.horizonStartDate }}
        ｜ 打印时间 {{ new Date().toLocaleString('zh-CN') }}
      </p>
      <p class="doc-meta">{{ version.notes }}</p>
      <table class="pgrid">
        <thead>
          <tr>
            <th>天</th><th>班次</th><th>开始</th><th>结束</th><th>项目</th><th>工步</th>
            <th>板规格</th><th>叠切</th><th>刀数(刀路)</th><th>刀向</th><th>时长</th><th>刀路出处</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in grp.rows" :key="r.rowId">
            <tr v-if="r.op.kind === 'setup'" class="p-setup">
              <td>{{ r.dayIndex + 1 }}</td><td>{{ r.shiftName }}</td>
              <td>{{ fmtHM(r.startMin % 1440) }}</td><td>{{ fmtHM(r.endMin % 1440) }}</td>
              <td colspan="7">⏸ {{ (r.reasons ?? []).join('、') }} 等待 {{ r.endMin - r.startMin }} 分钟</td>
              <td></td>
            </tr>
            <tr v-else>
              <td>第{{ r.dayIndex + 1 }}天</td>
              <td>{{ r.shiftName }}</td>
              <td>{{ fmtHM(r.startMin % 1440) }}</td>
              <td>{{ fmtHM(r.endMin % 1440) }}</td>
              <td>{{ r.op.jobName }}</td>
              <td>{{ r.op.kind === 'trim' ? '修边叠切' : '内部刀裁切' }}</td>
              <td>{{ r.op.boardDesc }}</td>
              <td>{{ r.op.stackSheets }}</td>
              <td>{{ r.op.bladeCount }}</td>
              <td>{{ r.op.axis === 'v' ? '竖' : '横' }}</td>
              <td>{{ fmtDur(r.op.workMin) }}</td>
              <td>
                <span v-for="(s, i) in r.op.source" :key="i">
                  板{{ s.sheetIndex + 1 }}刀{{ s.orderFrom + 1 }}<template v-if="s.orderTo > s.orderFrom">~{{ s.orderTo + 1 }}</template><template v-if="i < r.op.source.length - 1">；</template>
                </span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>

    <!-- 每单完工时刻与交期状态 -->
    <section class="print-page">
      <h2>每单完工时刻与交期状态（与项目列表/工单页同源）</h2>
      <table class="pgrid">
        <thead>
          <tr><th>项目</th><th>机台</th><th>完工时刻(一刻钟口径)</th><th>交期</th><th>状态</th><th>加工</th><th>等待</th><th>面积(m²)</th></tr>
        </thead>
        <tbody>
          <tr v-for="j in version.jobs" :key="j.jobId">
            <td>{{ j.jobName }}</td>
            <td>{{ j.machineName }}</td>
            <td>{{ fmtClock(j.finishQuarterMin) }}</td>
            <td>{{ fmtDue(j.dueAt) }}</td>
            <td><b :style="j.late ? 'color:#b91c1c' : ''">{{ j.late ? `赶不上（晚 ${j.lateMin} 分钟）` : '赶得上' }}</b></td>
            <td>{{ fmtDur(j.workMin) }}</td>
            <td>{{ j.setupMin }} 分</td>
            <td>{{ toM2(j.areaMm2).toFixed(2) }}</td>
          </tr>
        </tbody>
      </table>
      <h3 style="font-size: 13px; margin: 12px 0 4px">排不进来的单（卡在哪）</h3>
      <table v-if="version.unscheduled.length" class="pgrid">
        <thead><tr><th>项目</th><th>卡点</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="u in version.unscheduled" :key="u.jobId">
            <td>{{ u.jobName }}</td><td>{{ u.reason }}</td><td>{{ u.detail }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="doc-meta">无。</p>
    </section>
  </div>
</template>

<style scoped>
.print-doc {
  color: #000;
  font-size: 11px;
}
.print-doc h2 {
  font-size: 16px;
  margin-bottom: 6px;
}
.doc-meta {
  color: #333;
  margin: 0 0 8px;
  font-size: 10.5px;
}
table.pgrid {
  width: 100%;
  border-collapse: collapse;
  font-size: 9.5px;
}
table.pgrid th,
table.pgrid td {
  border: 1px solid #555;
  padding: 2.5px 4px;
  text-align: left;
}
table.pgrid th {
  background: #eee;
}
.p-setup td {
  background: #f0ede5;
}
</style>
