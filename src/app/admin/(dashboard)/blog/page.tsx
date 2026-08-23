'use client'

import { PostsManager } from '@/components/admin/PostsManager'
import { DonorBlogSubmissions } from '@/components/admin/DonorBlogSubmissions'

// Its own permission (can_publish_blog, migration 303) and its own page —
// the Author field already on every post is exactly the "who wrote this"
// byline a blog needs, typed by hand rather than tied to whoever is logged
// in, so a guest writer's name can be credited without giving them a login.
//
// DonorBlogSubmissions (migration 312) sits above the regular list — a
// donor at Darya (River) or above can submit their own post from the
// portal; approving one here is just "publish", same as any other post.
export default function AdminBlogPage() {
  return (
    <>
      <DonorBlogSubmissions />
      <PostsManager titleKey="y.blogManagement" newPostKey="y.newBlogPost" fixedCategory="blog" />
    </>
  )
}
