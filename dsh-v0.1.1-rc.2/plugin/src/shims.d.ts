/**
 * 声明浏览器环境下 DSH client 用到的宿主 API 最小类型面。
 * host 侧 tsc 不编译 client，这里只补齐 client.tsx 需要的类型，避免在宿主类型上耦合。
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface SlotsLifecycle<Props> {
    name?: string
    inject?: Record<string, unknown> | (() => Record<string, unknown>)
  }

  export class SlotsService<Props = Record<string, unknown>> {
    register(lifecycle: SlotsLifecycle<Props>, component: (props: Props) => JSX.Element | null): () => void
    inject(name: string, accessor: SlotsLifecycle<Props>): () => void
    entries<T extends { id: string; order: number }>(name: string): T[]
  }
}