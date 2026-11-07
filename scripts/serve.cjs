/* 零依赖静态服务器：把 out/web 跑起来（浏览器版预览 / 截图验证用） */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve('out/web')
const port = Number(process.argv[2] || 5188)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

http
  .createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0])
    if (rel === '/') rel = '/index.html'
    let file = path.join(root, rel)
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    const ext = path.extname(file)
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  .listen(port, '127.0.0.1', () => console.log('web preview: http://127.0.0.1:' + port))
