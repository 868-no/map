import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A value shown briefly (a "Copied" label), back to `idle` after `ms`.
 * Flashing again restarts the timer, and none outlives the component.
 */
export function useFlash<T>(idle: T, ms = 2500): [T, (v: T) => void] {
  const [value, setValue] = useState(idle)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const flash = useCallback((v: T) => {
    clearTimeout(timer.current)
    setValue(v)
    timer.current = setTimeout(() => setValue(idle), ms)
  }, [idle, ms])
  return [value, flash]
}
