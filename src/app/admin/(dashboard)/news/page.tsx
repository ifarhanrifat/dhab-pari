'use client'

import { PostsManager } from '@/components/admin/PostsManager'

// Poetry and Blog have their own pages/permission now (migration 303) — kept
// out of the category picker here so a News publisher isn't offered a
// category they hold no separate right to actually save.
export default function AdminNewsPage() {
  return <PostsManager titleKey="y.newsManagement" newPostKey="y.newPost" excludeCategoryKeys={['poetry', 'blog']} />
}
