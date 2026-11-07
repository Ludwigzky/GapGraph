/* 共享领域类型：主进程、渲染进程、测试三方共用，改一处即可 */

export type NodeKind = 'concept' | 'skill' | 'root'

export interface KNode {
  id: string
  name: string
  parentId: string | null
  kind: NodeKind
  /** 考频×分值归一化 0..1 */
  examWeight: number
  /** 前置考点：不会它，本篇学不动 */
  prereq: string[]
  /** 容易混淆的考点（对称） */
  confusable: string[]
  /** 讲解（预写，v0.1 不走 AI） */
  brief?: string
  /** 融合后的板块里，这个节点原本属于哪一章（出题时用它当上下文，防止串味） */
  origin?: string
}

export interface Relation {
  /** 前置：不会 a 就学不动 b；易混：a 与 b 互相干扰 */
  a: string
  b: string
  kind: 'prereq' | 'confusable'
  /** 一句话说清"为什么"，画在连线中间 */
  why: string
}

export interface Pack {
  packId: string
  title: string
  subject: string
  totalScore: number
  source: string
  /** 大厅里用来分组展示：哪个考试、哪一科、哪一章 */
  meta?: { exam: string; subject: string; chapter: string }
  nodes: KNode[]
  relations?: Relation[]
}

export type QuestionType = 'single' | 'blank' | 'judge'

export interface Tag {
  nodeId: string
  /** 主考点 1.0，次考点 0.4 */
  weight: number
  primary?: boolean
}

export interface Question {
  id: string
  type: QuestionType
  stem: string
  options?: string[]
  /** 判断题：'true' | 'false'；填空题：可接受答案数组 */
  answer: string[] | string
  solution?: string
  /** 1..5 */
  difficulty: number
  tags: Tag[]
}

export interface Mastery {
  /** 覆盖：0 没学过 / 0.5 学过不会 / 1 会 */
  K: number
  /** 能力：难度加权、时间衰减后的正确率估计（A = Aw / W） */
  A: number
  /** 稳定性（天），用于遗忘曲线 */
  s: number
  /** 累计作答（仅计入"有效证据"的次数） */
  n: number
  nok: number
  /** 时间衰减后的权重和 = 有效样本量，用于置信度 */
  W: number
  /** 时间衰减后的加权正确和，A = Aw / W */
  Aw: number
  /** 错误概念已固化 */
  misconception: 0 | 1
  lastAt: number | null
}

export type SelfConfidence = 'sure' | 'unsure' | 'unknown'

export type ErrorReason =
  | 'calc' | 'formula' | 'misread' | 'concept' | 'method' | 'guess' | null

export type TaskKind = 'review' | 'gap' | 'new'

export interface Task {
  id: string
  date: string
  kind: TaskKind
  nodeId: string
  questionIds: string[]
  estMinutes: number
  status: 'pending' | 'done' | 'postponed'
  sortOrder: number
}

export interface AttemptRecord {
  id: string
  questionId: string
  nodePrimary: string
  startedAt: number
  submittedAt: number
  durationMs: number
  correct: boolean
  selfConfidence: SelfConfidence
  /** 系统判定疑似蒙对 */
  guessed: boolean
  errorReason: ErrorReason
}

export interface Settings {
  dailyMinutes: number
  examDate: string
  totalScore: number
  packId: string
}

export interface AppState {
  settings: Settings
  mastery: Record<string, Mastery>
  attempts: AttemptRecord[]
  tasks: Task[]
}

export interface SubmitPayload {
  questionId: string
  answer: string
  durationMs: number
  selfConfidence: SelfConfidence
  errorReason: ErrorReason
}

export interface SubmitResult {
  correct: boolean
  nodeId: string
  before: number
  after: number
  /** 做完这道题，这个考点的色档从哪变到哪（红→橙→黄→绿） */
  beforeBand: 'red' | 'orange' | 'yellow' | 'green' | 'unmeasured'
  afterBand: 'red' | 'orange' | 'yellow' | 'green' | 'unmeasured'
  guessed: boolean
  solution?: string
  state: AppState
}

export interface LoadResult {
  pack: Pack
  questions: Question[]
  state: AppState
  today: Task[]
}
