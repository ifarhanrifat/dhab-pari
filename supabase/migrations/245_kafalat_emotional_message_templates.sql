-- Migration 245: the words on a Kafalat card — nothing hardcoded, same
-- admin-editable template system already used for WhatsApp messages.
INSERT INTO message_templates (key, label, body) VALUES
  ('kafalat_card_tagline', 'The short line shown on every child''s sponsor card',
   'Help me stay in school, like I was your own.'),
  ('kafalat_end_sponsorship', 'Shown before a donor ends a child''s sponsorship',
   'Are you sure? %%name%% has come to count on this every month. If something has changed for you, even lowering the amount keeps them in school — you do not have to choose between all or nothing.'),
  ('kafalat_thank_you', 'Shown once a donor confirms ending a sponsorship',
   'Thank you for everything you gave me this year, from %%name%%. I will not forget it.')
ON CONFLICT (key) DO NOTHING;
