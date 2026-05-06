const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}

function ts(): string {
  return new Date().toISOString().slice(11, 23)
}

export const log = {
  info: (tag: string, msg: string, ...rest: unknown[]) =>
    console.log(`${colors.dim}${ts()}${colors.reset} ${colors.cyan}[${tag}]${colors.reset} ${msg}`, ...rest),
  ok: (tag: string, msg: string, ...rest: unknown[]) =>
    console.log(`${colors.dim}${ts()}${colors.reset} ${colors.green}[${tag}]${colors.reset} ${msg}`, ...rest),
  warn: (tag: string, msg: string, ...rest: unknown[]) =>
    console.warn(`${colors.dim}${ts()}${colors.reset} ${colors.yellow}[${tag}]${colors.reset} ${msg}`, ...rest),
  err: (tag: string, msg: string, ...rest: unknown[]) =>
    console.error(`${colors.dim}${ts()}${colors.reset} ${colors.red}[${tag}]${colors.reset} ${msg}`, ...rest),
  debug: (tag: string, msg: string, ...rest: unknown[]) =>
    console.log(`${colors.dim}${ts()} [${tag}] ${msg}${colors.reset}`, ...rest),
}
