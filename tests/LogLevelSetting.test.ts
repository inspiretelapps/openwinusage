import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LogLevelSetting } from '@core/stores/LogLevelSetting'
import { MemoryDefaults, setStandardDefaults, standardDefaults, type Defaults } from '@core/support/Defaults'

describe('LogLevelSettingTests', () => {
  let saved: Defaults
  beforeEach(() => {
    saved = standardDefaults()
    setStandardDefaults(new MemoryDefaults())
  })
  afterEach(() => setStandardDefaults(saved))

  it('testLogLevelReadsTheChoiceSavedByZeroSevenSixteen', () => {
    standardDefaults().remove('logLevel')
    expect(LogLevelSetting.current).toBe('info')

    standardDefaults().set('logLevel', 'warn')
    expect(LogLevelSetting.current).toBe('warn')

    standardDefaults().set('logLevel', 'debug')
    expect(LogLevelSetting.current).toBe('debug')
  })

  it('testALogLevelKeepsOnlyLinesAtLeastAsSevere', () => {
    expect(LogLevelSetting.includes('info', 'warn')).toBe(true)
    expect(LogLevelSetting.includes('info', 'debug')).toBe(false)
    expect(LogLevelSetting.includes('debug', 'debug')).toBe(true)
    expect(LogLevelSetting.includes('error', 'warn')).toBe(false)
  })
})
