import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { classify, classifyPs } from './blast-radius.mjs'

const ok = (value: unknown) => ({ value }) as never

test('PowerShell deletes are classified, dry runs and reads are not', () => {
  expect(classifyPs('Remove-Item -Recurse -Force build')?.kind).toBe('rm')
  expect(classifyPs('Remove-Item -Recurse -Force build')?.quiet).toBe(false)
  expect(classifyPs('Remove-Item one.txt')?.quiet).toBe(true)
  expect(classifyPs('rm -r build; echo hi')?.targets).toEqual([{ path: 'build', literal: false }])
  expect(classifyPs("Set-Location 'C:\\Temp'; Remove-Item *.log")?.dir).toBe('C:\\Temp')
  expect(classifyPs('Get-ChildItem build | Remove-Item -Recurse')?.piped).toBe(true)
  expect(classifyPs('gci . | ForEach-Object { Remove-Item $_.FullName -Force }')?.unknownTargets).toBe(true)
  expect(classifyPs('Remove-Item -LiteralPath "G:\\My Drive\\x" -Recurse -WhatIf')).toBeNull()
  expect(classifyPs('cmd /c rd /s /q build')?.kind).toBe('rm')
  expect(classifyPs('git push --force origin main')?.kind).toBe('git-push-force')
  expect(classifyPs('Get-ChildItem -Recurse | Select-Object Name')).toBeNull()
  expect(classifyPs('Remove-Item -Path a.txt,b.txt -Force')?.targets?.length).toBe(2)
})

test('Bash deletes keep the original rules', () => {
  expect(classify('cd /c/Users && rm -rf build')?.dir).toBe('/c/Users')
  expect(classify('rm file.txt')).toBeNull()
  expect(classify('git reset --hard HEAD~1')?.kind).toBe('git-reset')
})

function world(on: On, measured: object) {
  mock.env(on, { OS: 'Windows_NT' })
  on('session.cwd', async () => ok('C:\\repo'))
  on('process.run', async ($, e) => {
    const isMeasure = e.argv.some(a => a.includes('Walk'))
    return ok({ exitCode: 0, stdout: isMeasure ? JSON.stringify(measured) : '', stderr: '' })
  })
  on('ui.open', async () => ok({ isPlaced: true }))
  on('ui.close', async () => ok(undefined))
  on('ui.toast', async () => ok(undefined))
  const ran: string[] = []
  on('tool.call', async ($, e) => {
    ran.push(String((e as { command?: string }).command))
    return { result: { stdout: 'ran', stderr: '' } } as never
  })
  return ran
}

test('a plain one-file Remove-Item outside the danger zones runs without a stop', async ($, on) => {
  const ran = world(on, { found: 1, files: 1, bytes: 10, dirs: 0, list: ['C:\\repo\\one.txt'], danger: [], unresolved: [], partial: false, cwd: 'C:\\repo' })
  const result = await $.tool.call({ tool: 'PowerShell', command: 'Remove-Item one.txt', tool_use_id: 't1' } as never)
  expect(ran).toEqual(['Remove-Item one.txt'])
  expect((result as { deny?: string }).deny).toBeUndefined()
})

test('a measuring failure refuses the command instead of letting it through', async ($, on) => {
  mock.env(on, { OS: 'Windows_NT' })
  on('session.cwd', async () => ok('C:\\repo'))
  on('process.run', async () => {
    throw new Error('powershell missing')
  })
  on('ui.open', async () => {
    throw new Error('no pane')
  })
  const ran: string[] = []
  on('tool.call', async ($, e) => {
    ran.push('x')
    return { result: { stdout: 'ran', stderr: '' } } as never
  })
  const result = await $.tool.call({ tool: 'PowerShell', command: 'Remove-Item -Recurse -Force build', tool_use_id: 't2' } as never)
  expect(ran).toEqual([])
  expect(JSON.stringify(result)).toContain('Blast Radius')
})
