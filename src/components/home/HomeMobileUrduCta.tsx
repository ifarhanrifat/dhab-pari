import Link from 'next/link'

export function HomeMobileUrduCta() {
  return (
    <section className="md:hidden mx-4 mb-6 bg-dp-primary p-6 rounded-lg text-center">
      <h3
        className="text-white text-[18px] mb-4"
        style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2.5' }}
      >
        کمیٹی سے رابطہ کریں۔
      </h3>
      <p
        className="text-white/80 text-[16px] leading-loose mb-6"
        style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2.5' }}
      >
        ڈھاب پڑی واٹر اینڈ ویلفیئر کمیٹی گاؤں کی ترقی اور خوشحالی کے لیے ہمہ وقت
        کوشاں ہے۔ کسی بھی شکایت یا تجویز کے لیے بٹن دبائیں۔
      </p>
      <Link
        href="/suggestions"
        className="inline-block bg-dp-secondary-fixed text-dp-on-secondary-fixed px-8 py-2 rounded-full font-sans text-[14px] font-semibold tracking-[0.05em]"
      >
        Suggest
      </Link>
    </section>
  )
}
