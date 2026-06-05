const net = require('net')

const LISTEN_PORT = 9222
const LISTEN_HOST = '::1' // IPv6 localhost
const FORWARD_PORT = 9223
const FORWARD_HOST = '127.0.0.1'

const server = net.createServer((socket) => {
  console.log(`[proxy] Connection received from ${socket.remoteAddress}:${socket.remotePort}`)
  const client = net.createConnection({ port: FORWARD_PORT, host: FORWARD_HOST }, () => {
    console.log('[proxy] Connected to target Chrome')
  })

  socket.pipe(client)
  client.pipe(socket)

  socket.on('error', (err) => {
    console.error('[proxy] Socket error:', err.message)
    client.end()
  })

  client.on('error', (err) => {
    console.error('[proxy] Client error:', err.message)
    socket.end()
  })
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[proxy] Listening on [${LISTEN_HOST}]:${LISTEN_PORT} -> [${FORWARD_HOST}]:${FORWARD_PORT}`)
})
