ALTER TABLE consumers ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE donors ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE news_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE committee_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallery_albums ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallery_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE news_ticker ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_log ENABLE ROW LEVEL SECURITY;

-- Public read policies
CREATE POLICY "public_read_projects"
  ON projects FOR SELECT USING (true);
CREATE POLICY "public_read_project_media"
  ON project_media FOR SELECT USING (true);
CREATE POLICY "public_read_donors"
  ON donors FOR SELECT USING (true);
CREATE POLICY "public_read_transactions"
  ON transactions FOR SELECT USING (true);
CREATE POLICY "public_read_published_news"
  ON news_posts FOR SELECT USING (is_published = true);
CREATE POLICY "public_read_published_videos"
  ON video_content FOR SELECT USING (is_published = true);
CREATE POLICY "public_read_active_members"
  ON committee_members FOR SELECT USING (is_active = true);
CREATE POLICY "public_read_albums"
  ON gallery_albums FOR SELECT USING (true);
CREATE POLICY "public_read_gallery_items"
  ON gallery_items FOR SELECT USING (true);
CREATE POLICY "public_read_active_ticker"
  ON news_ticker FOR SELECT USING (is_active = true);
CREATE POLICY "public_read_settings"
  ON site_settings FOR SELECT USING (true);
CREATE POLICY "public_read_bills"
  ON bills FOR SELECT USING (true);
CREATE POLICY "public_read_consumers"
  ON consumers FOR SELECT USING (true);
CREATE POLICY "public_insert_suggestions"
  ON suggestions FOR INSERT WITH CHECK (true);

-- Admin full access policies (authenticated users)
CREATE POLICY "admin_all_consumers" ON consumers
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_bills" ON bills
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_projects" ON projects
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_project_media" ON project_media
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_donors" ON donors
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_transactions" ON transactions
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_news" ON news_posts
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_videos" ON video_content
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_suggestions" ON suggestions
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_members" ON committee_members
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_albums" ON gallery_albums
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_gallery_items" ON gallery_items
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_ticker" ON news_ticker
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_settings" ON site_settings
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "admin_all_notifications" ON notifications_log
  FOR ALL USING (auth.role() = 'authenticated');
