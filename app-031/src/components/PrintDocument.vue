<script setup lang="ts">
import { computed } from 'vue'
import { printState } from '../lib/print'
import { getJob } from '../lib/store'
import { useSchedule } from '../lib/scheduleStore'
import { exportRows, clockOf, dateStrOf } from '../lib/schedule'
import boardsData from '../data/boards.json'
import SheetDiagram from './SheetDiagram.vue'
import { money, mm } from '../lib/format'

const job = computed(() => (printState.jobId ? getJob(printState.jobId) : undefined))
const sections = computed(() => new Set(printState.sections))
const now = computed(() => new Date().toLocaleString('zh-CN'))

// 排产表打印：与工单页/项目列表页同源（scheduleStore 的 live 结果）
const { live, schedState } = useSchedule()
const isSchedulePrint = computed(() => sections.value.has('schedule'))
const schedRows = computed(() => exportRows(live.value))
const schedOfJob = computed(() =>
  job.value ? live.value.scheduled.find((s) => s.jobId === job.value!.id) : undefined
)

const allInstances = computed(() => {
  if (!job.value?.result) return []
  return job.value.result.sheets.flatMap((s) => s.placements)
})

interface OrderRow {
  code: string
  name: string
  origLen: number
  origWid: number
  qty: number
  grain: string
  edgeCount: number
  exposed: boolean
}
const cabinetGroups = computed(() => {
  const map = new Map<string, OrderRow[]>()
  for (const p of allInstances.value) {
    const arr = map.get(p.cabinet) ?? []
    const cur = arr.find((r) => r.code === p.code)
    if (cur) cur.qty++
    else
      arr.push({
        code: p.code,
        name: p.name,
        origLen: p.origLen,
        origWid: p.origWid,
        qty: 1,
        grain: p.grain,
        edgeCount: p.edgeBands.length,
        exposed: p.exposed
      })
    map.set(p.cabinet, arr)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))
})

const grainText = (g: string): string =>
  g === 'length' ? '竖纹' : g === 'width' ? '横纹' : '无要求'

const boardByName = (name: string) =>
  job.value?.result?.sheets.find((x) => x.boardName === name)
</script>

<template>
  <div v-if="job || isSchedulePrint" class="print-doc print-only">
    <!-- 排产表（整表，与工单页/项目列表页同源） -->
    <section v-if="isSchedulePrint" class="print-page">
      <h2>开料工单排产表</h2>
      <p class="doc-meta">
        生成时间：{{ now }} ｜ 开工日：{{ live.startDay }} ｜ 排产 {{ live.horizonDays }} 天 ｜ 策略：{{ schedState.config.strategy === 'rush' ? '急件优先' : '按交期顺排' }}
        ｜ 机台等待：换刀向 {{ schedState.config.toolChangeMin }}′ / 换板种 {{ schedState.config.materialChangeMin }}′ / 换厚度 {{ schedState.config.thicknessChangeMin }}′
      </p>
      <p class="doc-meta">
        时间按分钟计、每单占用块向上取整到一刻钟（15 分钟）；面积按 mm² 累计、折算 m² 保留 2 位；工步(刀)数与裁切刀路同源（同规格板修边叠切算一次）。
      </p>
      <table class="pgrid">
        <thead>
          <tr>
            <th>序号</th><th>项目</th><th>机台</th><th>日期</th><th>班次</th>
            <th>开工</th><th>完工</th><th>占用(分钟)</th><th>板数</th><th>工步(刀)</th><th>面积m²</th><th>交期</th><th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in schedRows" :key="r.jobId">
            <td>{{ r.no }}</td>
            <td>{{ r.jobName }}</td>
            <td>{{ r.machineName }}</td>
            <td>{{ r.date }}</td>
            <td>{{ r.shiftName }}</td>
            <td>{{ r.startClock }}</td>
            <td><b>{{ r.finishClock }}</b></td>
            <td>{{ r.blockMin }}</td>
            <td>{{ r.sheets }}</td>
            <td>{{ r.ops }}</td>
            <td>{{ (r.areaMm2 / 1_000_000).toFixed(2) }}</td>
            <td>{{ r.dueText }}</td>
            <td>{{ r.status }}</td>
          </tr>
        </tbody>
      </table>
      <template v-if="live.unscheduled.length">
        <h3>排不进的活（卡在哪）</h3>
        <table class="pgrid">
          <thead><tr><th>项目</th><th>板数</th><th>工步(刀)</th><th>原因</th></tr></thead>
          <tbody>
            <tr v-for="u in live.unscheduled" :key="u.jobId">
              <td>{{ u.jobName }}</td><td>{{ u.sheets }}</td><td>{{ u.ops }}</td><td>{{ u.reason }}</td>
            </tr>
          </tbody>
        </table>
      </template>
      <template v-if="live.skipped.length">
        <h3>未纳入排产</h3>
        <table class="pgrid">
          <thead><tr><th>项目</th><th>原因</th></tr></thead>
          <tbody>
            <tr v-for="s in live.skipped" :key="s.jobId">
              <td>{{ s.jobName }}</td><td>{{ s.reason }}</td>
            </tr>
          </tbody>
        </table>
      </template>
    </section>

    <template v-if="job">
    <!-- 排样图 -->
    <div v-if="sections.has('nest')">
      <section
        v-for="s in job.result?.sheets ?? []"
        :key="'pn' + s.index"
        class="print-page"
      >
        <h2>排样图 · 第 {{ s.index + 1 }} 张 / 共 {{ job.result?.sheets.length }} 张</h2>
        <p class="doc-meta">
          {{ s.boardName }}（{{ s.material }} {{ s.thicknessMm }}mm） · 尺寸
          {{ s.wMm }}×{{ s.hMm }}mm · 利用率 {{ (s.utilization * 100).toFixed(1) }}% ·
          锯路 {{ job.kerfMm }}mm · 修边 {{ job.trimMm }}mm
        </p>
        <div class="print-sheet-wrap">
          <SheetDiagram :sheet="s" :show-cuts="false" print-mode />
        </div>
        <table class="pgrid">
          <thead>
            <tr>
              <th>序号</th><th>编号</th><th>名称</th><th>柜体</th>
              <th>尺寸(mm)</th><th>纹理</th><th>封边</th><th>见光</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in s.placements" :key="p.instanceId">
              <td>{{ p.seq }}</td>
              <td>{{ p.code }}</td>
              <td>{{ p.name }}</td>
              <td>{{ p.cabinet }}</td>
              <td>{{ mm(p.origLen) }}×{{ mm(p.origWid) }}</td>
              <td>{{ grainText(p.grain) }}</td>
              <td>{{ p.edgeBands.length }} 边</td>
              <td>{{ p.exposed ? '是' : '' }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 裁切步骤表 -->
    <div v-if="sections.has('cut')">
      <section
        v-for="s in job.result?.sheets ?? []"
        :key="'pc' + s.index"
        class="print-page"
      >
        <h2>裁切步骤表 · 第 {{ s.index + 1 }} 张（{{ s.boardName }}）</h2>
        <p class="doc-meta">按顺序下锯；同向刀已连续排程（减少推台翻转）；修边刀可多板叠切。</p>
        <table class="pgrid">
          <thead>
            <tr><th>刀序</th><th>类型</th><th>方向</th><th>位置(mm)</th><th>贯通区间(mm)</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="st in s.steps" :key="st.order">
              <td>{{ st.order + 1 }}</td>
              <td>{{ st.kind === 'trim' ? '修边' : '裁切' }}</td>
              <td>{{ st.axis === 'v' ? '竖刀' : '横刀' }}</td>
              <td>{{ Math.round(st.at) }}</td>
              <td>{{ st.span[0] }} ~ {{ st.span[1] }}</td>
              <td>{{ st.label }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 下料单 / 领料单 -->
    <div v-if="sections.has('order')">
      <section class="print-page">
        <h2>下料单 / 领料单</h2>
        <p class="doc-meta">
          项目：{{ job.name }} ｜ 打印时间：{{ now }}
          <template v-if="schedOfJob">
            ｜ 计划完工：{{ schedOfJob.date }} {{ clockOf(schedOfJob.finishMin) }}（{{ schedOfJob.machineName }} · {{ schedOfJob.shiftName }}）
            {{ schedOfJob.overdue ? '｜ ⚠ 超交期' : '' }}
            <template v-if="job.dueAt !== undefined">｜ 交期：{{ dateStrOf(job.dueAt) }}</template>
          </template>
        </p>

        <h3>一、板材领料</h3>
        <table class="pgrid">
          <thead>
            <tr><th>板材</th><th>规格(mm)</th><th>厚度</th><th>张数</th><th>单价</th><th>小计</th></tr>
          </thead>
          <tbody>
            <tr v-for="(n, name) in job.result?.boardsByType" :key="name">
              <td>{{ name }}</td>
              <td>{{ boardByName(String(name))?.wMm }}×{{ boardByName(String(name))?.hMm }}</td>
              <td>{{ boardByName(String(name))?.thicknessMm }}</td>
              <td>{{ n }}</td>
              <td>{{ money(boardByName(String(name))?.priceCents ?? 0) }}</td>
              <td>{{ money((boardByName(String(name))?.priceCents ?? 0) * Number(n)) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="5">板材合计</td>
              <td>{{ money(job.result?.totalCostCents ?? 0) }}</td>
            </tr>
          </tfoot>
        </table>

        <h3>二、零件明细（按柜体分拣）</h3>
        <div v-for="[cab, list] in cabinetGroups" :key="cab" class="avoid-break">
          <h4>柜体/房间：{{ cab }}（{{ list.reduce((a, r) => a + r.qty, 0) }} 件）</h4>
          <table class="pgrid">
            <thead>
              <tr><th>编号</th><th>名称</th><th>尺寸(mm)</th><th>数量</th><th>纹理</th><th>封边</th><th>见光</th></tr>
            </thead>
            <tbody>
              <tr v-for="g in list" :key="g.code">
                <td>{{ g.code }}</td>
                <td>{{ g.name }}</td>
                <td>{{ mm(g.origLen) }}×{{ mm(g.origWid) }}</td>
                <td>{{ g.qty }}</td>
                <td>{{ grainText(g.grain) }}</td>
                <td>{{ g.edgeCount }} 边</td>
                <td>{{ g.exposed ? '是' : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3>三、封边与五金辅料</h3>
        <table class="pgrid">
          <tbody>
            <tr><td>见光边封边</td><td>{{ job.result?.edgeBandM.exposed }} m</td></tr>
            <tr><td>非见光边封边</td><td>{{ job.result?.edgeBandM.normal }} m</td></tr>
            <tr><td>{{ boardsData.hardware.connectorName }}</td><td>{{ allInstances.length * boardsData.hardware.connectorPerPart }}</td></tr>
            <tr><td>{{ boardsData.hardware.dowelName }}</td><td>{{ allInstances.length * boardsData.hardware.dowelPerPart }}</td></tr>
            <tr><td>{{ boardsData.hardware.screwName }}</td><td>{{ allInstances.length * boardsData.hardware.screwPerPart }}</td></tr>
            <tr>
              <td>{{ boardsData.hardware.glueName }}</td>
              <td>{{ ((((job.result?.edgeBandM.exposed ?? 0) + (job.result?.edgeBandM.normal ?? 0)) * boardsData.hardware.glueGramPerEdgeMeter) / 1000).toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 标签（A4 不干胶，每块一张） -->
    <div v-if="sections.has('labels')">
      <section class="print-page labels-page">
        <div
          v-for="(p, i) in allInstances"
          :key="'lb' + i"
          class="label-card avoid-break"
        >
          <div class="lb-code">{{ p.code }} <span class="lb-seq">#{{ p.seq }}</span></div>
          <div class="lb-name">{{ p.name }}</div>
          <div class="lb-dims">{{ mm(p.origLen) }} × {{ mm(p.origWid) }} mm</div>
          <div class="lb-meta">{{ p.cabinet }} ｜ {{ grainText(p.grain) }} ｜ 封边 {{ p.edgeBands.length }} 边{{ p.exposed ? ' ｜ 见光' : '' }}</div>
        </div>
      </section>
    </div>
    </template>
  </div>
</template>

<style scoped>
.print-doc {
  color: #000;
  font-size: 12px;
}
.print-doc h2 {
  font-size: 17px;
  margin-bottom: 6px;
}
.print-doc h3 {
  font-size: 14px;
  margin: 14px 0 6px;
}
.print-doc h4 {
  font-size: 13px;
  margin: 10px 0 4px;
}
.doc-meta {
  color: #333;
  margin: 0 0 8px;
  font-size: 11px;
}
.print-sheet-wrap {
  border: 1px solid #888;
  padding: 6px;
  margin-bottom: 10px;
}
table.pgrid {
  width: 100%;
  border-collapse: collapse;
  font-size: 10.5px;
}
table.pgrid th,
table.pgrid td {
  border: 1px solid #555;
  padding: 2.5px 5px;
  text-align: left;
}
table.pgrid th {
  background: #eee;
}
.labels-page {
  display: grid;
  grid-template-columns: repeat(2, 94mm);
  gap: 4mm 6mm;
  justify-content: center;
}
.label-card {
  border: 1.5px solid #000;
  border-radius: 3px;
  padding: 3mm 3.5mm;
  height: 38mm;
  overflow: hidden;
}
.lb-code {
  font-size: 15px;
  font-weight: 700;
}
.lb-seq {
  font-weight: 400;
  font-size: 11px;
}
.lb-name {
  font-size: 12px;
  margin: 1mm 0;
}
.lb-dims {
  font-size: 18px;
  font-weight: 700;
  margin: 1mm 0;
}
.lb-meta {
  font-size: 10.5px;
}
</style>
