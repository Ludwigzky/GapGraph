import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppState, LoadResult, Pack, Question, SubmitPayload, SubmitResult, Task } from '../shared/types'
import { DAY, applyAttempt, band, effective, freshMastery, masteryScore, migrateMastery, setSelfLevel } from './domain/mastery'
import { buildToday, blankMastery, coverage, daysUntil } from './domain/queue'
import { isCorrect } from './domain/grading'
import { buildAttemptRecord } from './domain/attempt-log'

interface QuestionBank {
  packId: string
  questions: Question[]
}

function resourceRoot(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const direct = join(base, 'resources')
  return existsSync(direct) ? direct : join(process.cwd(), 'resources')
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function todayKey(now: number): string {
  const d = new Date(now)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export class Service {
  pack!: Pack
  questions: Question[] = []
  private state!: AppState
  private file = ''

  constructor() {
    const root = resourceRoot()
    this.pack = readJson<Pack>(join(root, 'packs', 'gaokao-math-function.json'))
    const bank = readJson<QuestionBank>(join(root, 'questions', 'gaokao-math-function.json'))
    this.questions = bank.questions

    const dir = join(app.getPath('userData'), 'data')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'state.json')
    this.state = this.loadState()
  }

  private defaultState(): AppState {
    return {
      settings: {
        dailyMinutes: 40,
        examDate: '2027-06-07',
        totalScore: this.pack.totalScore,
        packId: this.pack.packId
      },
      mastery: blankMastery(this.pack.nodes),
      attempts: [],
      tasks: []
    }
  }

  private loadState(): AppState {
    if (!existsSync(this.file)) return this.defaultState()
    try {
      const s = readJson<AppState>(this.file)
      // 补全新增节点，避免升级后出现空洞
      for (const n of this.pack.nodes) {
        if (!s.mastery[n.id]) s.mastery[n.id] = freshMastery(n.kind === 'root' ? 1 : 0)
      }
      // v1 → v2 迁移：把自评/能力/保持/可信度拆开。幂等，重复执行不改任何数。
      for (const id of Object.keys(s.mastery)) s.mastery[id] = migrateMastery(s.mastery[id])
      s.schemaVersion = 2
      return s
    } catch {
      return this.defaultState()
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8')
  }

  private daysLeft(now: number): number {
    return daysUntil(this.state.settings.examDate, now)
  }

  today(now = Date.now()): Task[] {
    const key = todayKey(now)
    const existing = this.state.tasks.filter((t) => t.date === key)
    if (existing.length > 0) return existing.sort((a, b) => a.sortOrder - b.sortOrder)
    return this.rebuild(now, key)
  }

  rebuild(now = Date.now(), key = todayKey(now)): Task[] {
    const tasks = buildToday({
      nodes: this.pack.nodes,
      questions: this.questions,
      mastery: this.state.mastery,
      now,
      dailyMinutes: this.state.settings.dailyMinutes,
      daysLeft: this.daysLeft(now),
      date: key
    })
    this.state.tasks = [...this.state.tasks.filter((t) => t.date !== key), ...tasks]
    this.save()
    return tasks
  }

  load(): LoadResult {
    const now = Date.now()
    return {
      pack: this.pack,
      questions: this.questions,
      state: this.state,
      today: this.today(now)
    }
  }

  submit(payload: SubmitPayload): SubmitResult {
    const now = Date.now()
    const q = this.questions.find((x) => x.id === payload.questionId)
    if (!q) throw new Error(`题目不存在: ${payload.questionId}`)

    const correct = isCorrect(q, payload.answer)
    // 疑似蒙对：3 秒内答对一道中高难度题
    const guessed = correct && payload.durationMs < 3000 && q.difficulty >= 3

    const primary = q.tags.find((t) => t.primary) ?? q.tags[0]
    const mBefore = this.state.mastery[primary.nodeId] ?? freshMastery(0)
    const before = masteryScore(mBefore, now)
    const beforeBand = band(mBefore, now)

    for (const tag of q.tags) {
      const m = this.state.mastery[tag.nodeId] ?? freshMastery(0)
      // 答错时次考点影响再打三折，避免"一题连坐"
      const weight = tag.primary || correct ? tag.weight : tag.weight * 0.3
      this.state.mastery[tag.nodeId] = applyAttempt(m, {
        difficulty: q.difficulty,
        correct,
        weight,
        sure: payload.selfConfidence === 'sure',
        guessed,
        now,
        errorReason: correct ? null : payload.errorReason
      })
    }

    this.state.attempts.push(
      buildAttemptRecord({
        id: `a_${now}_${Math.random().toString(36).slice(2, 8)}`,
        question: q,
        primaryNodeId: primary.nodeId,
        correct,
        guessed,
        durationMs: payload.durationMs,
        now,
        selfConfidence: payload.selfConfidence,
        errorReason: payload.errorReason
      })
    )
    if (this.state.attempts.length > 2000) this.state.attempts.shift()

    // 完成了这张卡上的题，就把卡标记完成
    const task = this.state.tasks.find(
      (t) => t.status === 'pending' && t.questionIds.includes(q.id)
    )
    if (task && correct) task.status = 'done'

    this.save()

    const after = masteryScore(this.state.mastery[primary.nodeId], now)
    return {
      correct,
      nodeId: primary.nodeId,
      before,
      after,
      beforeBand,
      afterBand: band(this.state.mastery[primary.nodeId], now),
      guessed,
      solution: q.solution,
      state: this.state
    }
  }

  completeTask(taskId: string): { state: AppState; today: Task[] } {
    const t = this.state.tasks.find((x) => x.id === taskId)
    if (t) t.status = 'done'
    this.save()
    return { state: this.state, today: this.today() }
  }

  postponeTask(taskId: string): { state: AppState; today: Task[] } {
    const t = this.state.tasks.find((x) => x.id === taskId)
    if (t) t.status = 'postponed'
    this.save()
    return { state: this.state, today: this.today() }
  }

  /** 只判对错，不改任何状态 —— 让界面能在落库前先问错因 */
  check(questionId: string, answer: string): { correct: boolean } {
    const q = this.questions.find((x) => x.id === questionId)
    if (!q) throw new Error(`题目不存在: ${questionId}`)
    return { correct: isCorrect(q, answer) }
  }

  updateSettings(patch: Partial<AppState['settings']>): { state: AppState; today: Task[]; overview: ReturnType<Service['overview']> } {
    const s = this.state.settings
    if (typeof patch.dailyMinutes === 'number') {
      s.dailyMinutes = Math.max(10, Math.min(240, Math.round(patch.dailyMinutes)))
    }
    if (typeof patch.examDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patch.examDate)) {
      s.examDate = patch.examDate
    }
    if (typeof patch.totalScore === 'number' && patch.totalScore > 0) {
      s.totalScore = Math.round(patch.totalScore)
    }
    this.save()
    const key = todayKey(Date.now())
    this.state.tasks = this.state.tasks.filter((t) => t.date !== key)
    const today = this.rebuild(Date.now(), key)
    return { state: this.state, today, overview: this.overview() }
  }

  /** 三档自评：没学过 0 / 学过不会 0.5 / 会 1（"会"也只给 0.6 分，余量留给证据） */
  rate(nodeId: string, level: 0 | 1 | 2): AppState {
    const m = this.state.mastery[nodeId] ?? freshMastery(0)
    // v2：自评只是主观报告，**不再**顺手把能力改成 0.6
    const levelName = level === 0 ? 'none' : level === 1 ? 'weak' : 'basic'
    this.state.mastery[nodeId] = setSelfLevel(m, levelName, Date.now())
    this.save()
    return this.state
  }

  overview() {
    const now = Date.now()
    const cov = coverage(this.state, this.pack.nodes)
    const effs = this.pack.nodes
      .filter((n) => n.kind !== 'root')
      .map((n) => effective(this.state.mastery[n.id] ?? freshMastery(0), now).eff)
    const raw = effs.reduce((a, b) => a + b, 0) / Math.max(1, effs.length)
    const est = this.state.settings.totalScore * (0.55 + 0.45 * raw)
    const band = est * 0.09
    return {
      coverage: cov,
      estimate: Math.round(est),
      band: Math.round(band),
      daysLeft: this.daysLeft(now),
      todayKey: todayKey(now),
      staleAfterDays: DAY
    }
  }
}
