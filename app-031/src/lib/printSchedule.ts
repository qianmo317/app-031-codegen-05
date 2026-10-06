import { reactive } from 'vue'

interface SchedulePrintState {
  versionId: string | null
}

export const schedulePrintState = reactive<SchedulePrintState>({
  versionId: null
})

export function printSchedule(versionId: string): void {
  schedulePrintState.versionId = versionId
  // 等打印文档渲染完再唤起打印
  setTimeout(() => window.print(), 60)
}
