/**
 * Load the Tempo router key from the macOS Keychain for operator scripts.
 *
 * The key left `.dev.vars` in the 2026-11-07 rotation. It never goes through a
 * shell, argv, a log line or a file: `security -w` writes it to the captured
 * stdout of this process only. Callers must not print the returned value.
 */
import { execFileSync } from 'node:child_process'

import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

export const TEMPO_ROUTER_KEYCHAIN_SERVICE = 'rozo.mpprouter.tempo-router-20261107'
export const TEMPO_ROUTER_KEYCHAIN_ACCOUNT = 'tempo-router'

export type KeychainRead = (service: string, account: string) => string

const readKeychain: KeychainRead = (service, account) =>
  execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })

export function loadTempoRouterAccount(read: KeychainRead = readKeychain): PrivateKeyAccount {
  let value: string
  try {
    value = read(TEMPO_ROUTER_KEYCHAIN_SERVICE, TEMPO_ROUTER_KEYCHAIN_ACCOUNT).trim()
  } catch {
    throw new Error(`Tempo router key not found in Keychain service ${TEMPO_ROUTER_KEYCHAIN_SERVICE}`)
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Keychain service ${TEMPO_ROUTER_KEYCHAIN_SERVICE} does not hold a 32-byte hex key`)
  }
  return privateKeyToAccount(value as `0x${string}`)
}
