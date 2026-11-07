/**
 * 只启停「我们自己那一个」无头浏览器。
 *
 * 背景：之前验证脚本里用 `taskkill /F /IM msedge.exe` 收尾，
 * 那是按**进程名**杀，会连用户自己开着的浏览器一起杀，标签页全丢。
 *
 * 这个脚本的原则：
 *   1. 启动时记下自己那份进程的 PID
 *   2. 停止时只 `taskkill /T /PID <自己那个>`，绝不按名字杀
 *   3. 杀之前再核一次命令行里有没有我们的专用 profile 目录，防止 PID 复用误杀
 *
 * 用法：
 *   node scripts/probe-browser.cjs start --port 9490 [--url http://127.0.0.1:3300/]
 *   node scripts/probe-browser.cjs status
 *   node scripts/probe-browser.cjs stop
 */
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const CACHE = path.join(ROOT, '.cache')
const STATE = path.join(CACHE, 'probe-edge.json')
const PROFILE = path.join(CACHE, 'edge-prof')

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p))

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'))
  } catch {
    return null
  }
}

function writeState(s) {
  fs.mkdirSync(CACHE, { recursive: true })
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2))
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 命令行里带我们的专用 profile，才算"我们那份" */
function isOurs(pid) {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', timeout: 8000 }
    )
    return out.includes('edge-prof')
  } catch {
    // 查不到命令行时保守判断：有 PID 文件且进程还在，认为是我们起的
    return true
  }
}

/** 删专用 profile：Edge 刚退出时还占着文件句柄，删不掉是正常的，重试几次就算了 */
function rmProfile() {
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    /* 留着也无妨，下次 start 会再清 */
  }
}

function cmdStart() {
  if (!EDGE) {
    console.error('找不到 msedge.exe')
    process.exit(1)
  }
  const prev = readState()
  if (prev && alive(prev.pid) && isOurs(prev.pid)) {
    console.log(`已有实例在跑: pid=${prev.pid} port=${prev.port}`)
    return
  }
  const port = arg('port', '9490')
  const url = arg('url', 'http://127.0.0.1:3300/')
  rmProfile()
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1440,940',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${PROFILE}`,
      url
    ],
    { detached: true, stdio: 'ignore' }
  )
  child.unref()
  writeState({ pid: child.pid, port: Number(port), url, startedAt: Date.now() })
  console.log(`started pid=${child.pid} port=${port}`)
}

function cmdStatus() {
  const s = readState()
  if (!s) {
    console.log('没有记录（未启动过）')
    return
  }
  const ok = alive(s.pid) && isOurs(s.pid)
  console.log(`${ok ? '运行中' : '已退出'} pid=${s.pid} port=${s.port} ours=${ok}`)
}

function cmdStop() {
  const s = readState()
  if (!s) {
    console.log('没有记录，无需停止')
    return
  }
  if (!alive(s.pid)) {
    console.log(`pid=${s.pid} 已不在，清理记录`)
    fs.rmSync(STATE, { force: true })
    return
  }
  if (!isOurs(s.pid)) {
    // 关键保护：PID 被别的进程复用了，绝不能杀
    console.log(`pid=${s.pid} 不是我们的实例（命令行里没有 edge-prof），拒绝杀死`)
    fs.rmSync(STATE, { force: true })
    return
  }
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(s.pid)], { stdio: 'ignore', timeout: 15000 })
    console.log(`已停止自己的实例 pid=${s.pid}（只杀了这一棵进程树）`)
  } catch (e) {
    console.log(`停止失败: ${e.message}`)
  }
  fs.rmSync(STATE, { force: true })
  rmProfile()
}

const action = process.argv[2] || 'status'
if (action === 'start') cmdStart()
else if (action === 'stop') cmdStop()
else if (action === 'status') cmdStatus()
else {
  console.log('用法: node scripts/probe-browser.cjs start|status|stop --port 9490')
  process.exit(1)
}
