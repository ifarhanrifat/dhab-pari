'use client'

import { PostsManager } from '@/components/admin/PostsManager'

// Its own permission (can_publish_poetry, migration 303) and its own page —
// a publisher granted only Poetry never sees /admin/news at all (AdminSidebar
// hides it), and the category is fixed so they never see the picker either.
export default function AdminPoetryPage() {
  return <PostsManager titleKey="y.poetryManagement" newPostKey="y.newPoem" fixedCategory="poetry" />
}
