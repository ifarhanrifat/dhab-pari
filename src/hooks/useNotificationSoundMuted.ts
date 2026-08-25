'use client'
import { useEffect, useState } from 'react'

const KEY = 'dp_notif_sound_muted'

// One shared on/off switch for the notification chime, used by both the
// portal and admin bells — a single localStorage flag rather than a
// per-bell setting, since it's the same person's browser either way.
export function useNotificationSoundMuted() {
  const [muted, setMutedState] = useState(false)

  useEffect(() => {
    setMutedState(localStorage.getItem(KEY) === 'true')
  }, [])

  const setMuted = (value: boolean) => {
    setMutedState(value)
    localStorage.setItem(KEY, String(value))
  }

  return { muted, setMuted }
}
