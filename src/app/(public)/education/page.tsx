import type { Metadata } from 'next'
import { GraduationCap, BookOpen, Award, Users } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Education Corner',
  description: 'Scholarship programs, student achievements, and educational initiatives in Dhab Pari.',
}
import Link from 'next/link'

export default function EducationPage() {
  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      {/* Header */}
      <div className="text-center mb-12 max-w-3xl mx-auto">
        <div className="inline-flex items-center justify-center p-3 bg-blue-100 rounded-full text-blue-600 mb-4">
          <GraduationCap size={32} />
        </div>
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-2">
          Education Corner
        </h1>
        <p className="text-dp-on-surface-variant font-sans text-[18px] leading-[28px]">
          Supporting the next generation of Dhab Pari through scholarships,
          resources, and community learning.
        </p>
      </div>

      {/* Scholarship Info Cards */}
      <section className="mb-16">
        <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-6">
          Scholarship Programs
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white border border-dp-outline-variant rounded-lg p-6 hover:border-dp-secondary transition-all">
            <div className="w-12 h-12 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center mb-4">
              <BookOpen size={24} />
            </div>
            <h3 className="font-sans text-[18px] font-bold leading-[28px] text-dp-on-surface mb-2">
              Primary Education Fund
            </h3>
            <p className="text-dp-on-surface-variant font-sans text-[14px] mb-4">
              Covers school fees, books, and uniforms for underprivileged
              students from Class 1 to 5 in the village school.
            </p>
            <div className="flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold">
              <Users size={14} />
              <span>25 students supported</span>
            </div>
          </div>

          <div className="bg-white border border-dp-outline-variant rounded-lg p-6 hover:border-dp-secondary transition-all">
            <div className="w-12 h-12 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center mb-4">
              <Award size={24} />
            </div>
            <h3 className="font-sans text-[18px] font-bold leading-[28px] text-dp-on-surface mb-2">
              Merit Scholarship
            </h3>
            <p className="text-dp-on-surface-variant font-sans text-[14px] mb-4">
              Annual scholarship for top-performing students in Matric and
              Intermediate exams. Covers tuition and transport costs.
            </p>
            <div className="flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold">
              <Award size={14} />
              <span>PKR 15,000 per year</span>
            </div>
          </div>

          <div className="bg-white border border-dp-outline-variant rounded-lg p-6 hover:border-dp-secondary transition-all">
            <div className="w-12 h-12 rounded-lg bg-amber-100 text-amber-600 flex items-center justify-center mb-4">
              <GraduationCap size={24} />
            </div>
            <h3 className="font-sans text-[18px] font-bold leading-[28px] text-dp-on-surface mb-2">
              Higher Education Support
            </h3>
            <p className="text-dp-on-surface-variant font-sans text-[14px] mb-4">
              Partial funding for village students admitted to public
              universities. Priority given to STEM and medical fields.
            </p>
            <div className="flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold">
              <Users size={14} />
              <span>8 university students</span>
            </div>
          </div>
        </div>
      </section>

      {/* Student Achievements */}
      <section className="mb-16">
        <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-6">
          Student Achievements
        </h2>
        <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
          {[
            { name: 'Aisha Malik', achievement: 'Topped District Board Exam — Matric Science (2024)', grade: '1st Position' },
            { name: 'Hassan Ghulam', achievement: 'Selected for Punjab Youth Science Olympiad', grade: 'Gold Medal' },
            { name: 'Fatima Zahoor', achievement: 'Admission to NUST Islamabad — BS Computer Science', grade: 'Merit Based' },
            { name: 'Ahmad Rasheed', achievement: 'Hafiz-e-Quran completion at age 12', grade: 'Completed' },
            { name: 'Sana Arshad', achievement: 'Won District-level Urdu Debate Competition', grade: '1st Prize' },
          ].map((s, i) => (
            <div
              key={i}
              className={`p-5 flex flex-col md:flex-row md:items-center justify-between gap-2 ${i % 2 === 1 ? 'bg-dp-surface-container' : ''}`}
            >
              <div>
                <h4 className="font-sans text-[16px] font-bold text-dp-on-surface">{s.name}</h4>
                <p className="font-sans text-[14px] text-dp-on-surface-variant">{s.achievement}</p>
              </div>
              <span className="bg-dp-secondary-container text-dp-on-secondary-container px-3 py-1 rounded-full text-[12px] font-bold font-sans shrink-0 w-fit">
                {s.grade}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-8 text-center">
        <h3 className="font-heading text-[24px] font-bold leading-[32px] text-blue-900 mb-2">
          Want to Support Education?
        </h3>
        <p className="text-blue-700 font-sans text-[16px] mb-6">
          Your donation can help a child attend school, buy books, or pursue higher education.
        </p>
        <Link
          href="/donate"
          className="inline-block bg-blue-600 text-white px-8 py-3 rounded-lg font-sans font-semibold hover:bg-blue-700 transition-all"
        >
          Donate for Education
        </Link>
      </div>
    </div>
  )
}
