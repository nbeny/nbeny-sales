/**
 * Tunnel SSH le temps d'un envoi. Le port de soumission de Mailcow n'est
 * ouvert que sur le LAN du cluster : on passe par le noeud `pve`, comme pour
 * toute machine 10.0.0.x, et on referme dès que l'envoi est fini.
 */
import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { setTimeout as pause } from 'node:timers/promises'

export interface TunnelOptions {
  jumpHost: string
  target: string
  targetPort: number
  readyTimeoutMs?: number
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

export async function withTunnel<T>(options: TunnelOptions, fn: (localPort: number) => Promise<T>): Promise<T> {
  const port = await freePort()
  const timeoutMs = options.readyTimeoutMs ?? 15_000
  const ssh = spawn(
    'ssh',
    ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:' + port + ':' + options.target + ':' + options.targetPort, options.jumpHost],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  )
  const state = { stderr: '', failure: '' }
  ssh.stderr.on('data', (chunk) => { state.stderr += chunk })
  ssh.on('error', (error) => { state.failure ||= 'ssh introuvable ou non lançable : ' + error.message })
  ssh.on('exit', (code) => { state.failure ||= 'ssh s\'est arrêté (code ' + code + ') : ' + (state.stderr.trim() || 'aucun message') })

  try {
    const deadline = Date.now() + timeoutMs
    while (!(await portAccepts(port))) {
      if (state.failure) {
        throw new Error('Tunnel vers ' + options.target + ':' + options.targetPort + ' via ' + options.jumpHost + ' impossible. ' + state.failure)
      }
      if (Date.now() > deadline) throw new Error('Tunnel SSH non prêt après ' + timeoutMs / 1000 + ' s. ' + state.stderr.trim())
      await pause(250)
    }
    return await fn(port)
  } finally {
    if (ssh.exitCode === null && ssh.signalCode === null) ssh.kill()
  }
}
