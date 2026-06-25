'use client'
import { useState, useEffect } from 'react'
import { translations } from '@/lib/translations'

export function useTranslation() {
  const [lang, setLang] = useState<'en' | 'ur'>('en')

  useEffect(() => {
    const saved = localStorage.getItem('lang') as 'en' | 'ur'
    if (saved) setLang(saved)
  }, [])

  const toggle = () => {
    const next = lang === 'en' ? 'ur' : 'en'
    setLang(next)
    localStorage.setItem('lang', next)
    document.documentElement.dir = next === 'ur' ? 'rtl' : 'ltr'
  }

  const t = translations[lang]
  return { lang, t, toggle, isUrdu: lang === 'ur' }
}
