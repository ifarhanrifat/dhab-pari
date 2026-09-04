-- Migration 442: waivers (438) join the same "what happened since the
-- last meeting" digest every other kind of activity already feeds --
-- the user's own spec for this feature explicitly wanted the agenda to
-- read "we have waived N bills of consumers/donors for this reason as
-- per committee agreement," and this is the one place that assembles
-- that feed (recent_activity_since, 151).
--
-- Four sources, one per waivable table -- same shape as the wazifa/
-- academy UNION branches already added to Recent/All Transactions
-- (438/439's frontend work): bills, wazifa_repayment_schedule,
-- wazifa_installment_charges, training_fee_charges. actor_name carries
-- who it was waived FOR (the consumer/student), matching how every
-- other branch here names a person, not who acted -- the reason itself
-- is the "why", already in detail.
CREATE OR REPLACE FUNCTION recent_activity_since(p_since timestamptz) RETURNS TABLE (
  event_type varchar, title text, detail text, actor_name text, created_at timestamptz
) AS $$
  SELECT 'job' AS event_type, jl.headline AS title, jl.category AS detail, jl.contact_name AS actor_name, jl.created_at
  FROM job_listings jl WHERE jl.created_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'volunteer', COALESCE(p.title, 'General — Any Project'), v.message, pu.full_name, v.created_at
  FROM volunteers v
  JOIN portal_users pu ON pu.id = v.portal_user_id
  LEFT JOIN projects p ON p.id = v.project_id
  WHERE v.created_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'comment', p.title, c.content,
    (CASE WHEN c.comment_type = 'system' THEN c.system_label ELSE pu2.full_name END),
    c.created_at
  FROM project_comments c
  JOIN projects p ON p.id = c.project_id
  LEFT JOIN portal_users pu2 ON pu2.id = c.portal_user_id
  WHERE c.created_at >= p_since AND c.is_hidden = false AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'complaint', COALESCE(cp.complaint_number, 'Complaint'), cp.complaint_text, cp.complainant_name, cp.created_at
  FROM complaints cp WHERE cp.created_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'suggestion', 'Suggestion', s.message, COALESCE(s.name, 'Anonymous'), s.created_at
  FROM suggestions s WHERE s.created_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'donation', (CASE WHEN d.is_anonymous THEN 'Anonymous donor' ELSE d.name END),
    'Rs. ' || to_char(d.amount_pkr, 'FM999999999') || CASE WHEN pr.title IS NOT NULL THEN ' - ' || pr.title ELSE '' END,
    (CASE WHEN d.is_anonymous THEN 'Anonymous donor' ELSE d.name END), d.confirmed_at
  FROM donors d
  LEFT JOIN projects pr ON pr.id = d.project_id
  WHERE d.is_verified = true AND d.confirmed_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'proposal', p2.title, 'Rs. ' || to_char(COALESCE(p2.budget_pkr, 0), 'FM999999999'), pu3.full_name, p2.created_at
  FROM projects p2
  JOIN portal_users pu3 ON pu3.id = p2.proposed_by_portal_user_id
  WHERE p2.proposed_by_portal_user_id IS NOT NULL AND p2.created_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'waiver', 'Bill #' || COALESCE(b.bill_number, '') || ' waived',
    'Rs. ' || to_char(b.amount_pkr, 'FM999999999') || COALESCE(' -- ' || b.waived_reason, ''),
    COALESCE(c.name, b.consumer_id), b.waived_at
  FROM bills b
  LEFT JOIN consumers c ON c.consumer_id = b.consumer_id
  WHERE b.status = 'waived' AND b.waived_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'waiver', 'Wazifa instalment waived',
    'Rs. ' || to_char(r.amount_pkr, 'FM999999999') || COALESCE(' -- ' || r.waived_reason, ''),
    st.full_name, r.waived_at
  FROM wazifa_repayment_schedule r
  JOIN wazifa_awards a ON a.id = r.award_id
  JOIN wazifa_students st ON st.id = a.student_id
  WHERE r.status = 'waived' AND r.waived_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'waiver', 'Wazifa charge waived',
    'Rs. ' || to_char(wc.amount_pkr, 'FM999999999') || COALESCE(' -- ' || wc.waived_reason, ''),
    st2.full_name, wc.waived_at
  FROM wazifa_installment_charges wc
  JOIN wazifa_awards a2 ON a2.id = wc.award_id
  JOIN wazifa_students st2 ON st2.id = a2.student_id
  WHERE wc.status = 'waived' AND wc.waived_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'waiver', 'Academy fee waived',
    'Rs. ' || to_char(tf.amount_pkr, 'FM999999999') || COALESCE(' -- ' || tf.waived_reason, ''),
    e.student_name, tf.waived_at
  FROM training_fee_charges tf
  JOIN training_enrollments e ON e.id = tf.enrollment_id
  WHERE tf.status = 'waived' AND tf.waived_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  ORDER BY created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
