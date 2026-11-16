insert into connections (id, label, detail, position) values
  ('composio_cloudinary', 'Cloudinary via Composio', 'Connect your Cloudinary account to host campaign images.', 8)
on conflict (id) do nothing;
