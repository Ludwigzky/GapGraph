/* 共享领域类型：主进程、渲染进程、测试三方共用，改一处即可 */

export type NodeKind = 'concept' | 'skill' | 'root'

/**
 * 权重来源。区分"这个数是怎么来的"，决定界面上能不能叫它"考频"。
 * - ai：模型生成章节时给的估计，没有任何真实考试数据支撑
 * - manual：人工整理/校对过的课程重要性，仍然**不是**历年考频统计
 * - stats：真的统计过历年真题（需要年份与样本量），目前**没有任何节点属于这一档**
 */
export type WeightSource = 'ai' | 'manual' | 'stats'

export interface KNode {
  id: string
  name: string
  parentId: string | null
  kind: NodeKind
  /** 重要性 0..1。注意：这是"重要程度"的估计，不是历史考察频率 */
  examWeight: number
  /** examWeight 的来源，缺省按 'ai' 处理 */
  weightSource?: WeightSource
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
  /**
   * 这个状态是怎么来的：
   * - none  什么信息都没有（没自评、没答题）
   * - self  只有用户自评，还没做过一道题 —— 不能当成诊断结论
   * - tested 至少有过一次有效作答
   * 老存档没有这个字段，按 n/K 推断（见 evidenceOf）。
   */
  evidence?: 'none' | 'self' | 'tested'
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

/** 一次作答对某个考点的证据分量（一道题可能同时挂多个考点） */
export interface AttemptTag {
  nodeId: string
  weight: number
  primary: boolean
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
  /**
   * 本次作答实际影响到的全部考点及权重。
   * 老记录没有这个字段 —— 读的时候按 nodePrimary 兜底（见 nodesOfAttempt）。
   * 存它的理由：一道综合题会同时推动多个节点的掌握度，
   * 只记主节点的话，事后没法回答"这个副考点的分数为什么变了"。
   */
  tags?: AttemptTag[]
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
  beforeBand: 'red' | 'orange' | 'yellow' | 'green' | 'self' | 'unmeasured'
  afterBand: 'red' | 'orange' | 'yellow' | 'green' | 'self' | 'unmeasured'
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
