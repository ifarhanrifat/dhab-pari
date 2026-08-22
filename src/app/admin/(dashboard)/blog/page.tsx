'use client'

import { PostsManager } from '@/components/admin/PostsManager'

// Its own permission (can_publish_blog, migration 303) and its own page —
// the Author field already on every post is exactly the "who wrote this"
// byline a blog needs, typed by hand rather than tied to whoever is logged
// in, so a guest writer's name can be credited without giving them a login.
export default function AdminBlogPage() {
  return <PostsManager titleKey="y.blogManagement" newPostKey="y.newBlogPost" fixedCategory="blog" />
}
