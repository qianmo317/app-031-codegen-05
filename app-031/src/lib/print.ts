import { reactive } from 'vue'

export type PrintSection = 'nest' | 'cut' | 'order' | 'labels' | 'schedule'

interface PrintState {
  jobId: string | null
  sections: PrintSection[]
}

export const printState = reactive<PrintState>({
  jobId: null,
  sections: ['nest', 'cut', 'order', 'labels']
})

export function printJob(jobId: string, sections: PrintSection[]): void {
  printState.jobId = jobId
  printState.sections = sections
  // 等打印文档渲染完再唤起打印
  setTimeout(() => window.print(), 60)
}

/** 打印整表排产单（数据与工单页/项目列表页同源，取自 scheduleStore 的 live 结果）。 */
export function printSchedule(): void {
  printState.jobId = null
  printState.sections = ['schedule']
  setTimeout(() => window.print(), 60)
}
