-- Roles y permisos iniciales (matriz propuesta en la Etapa 1; ajustable).
INSERT INTO roles (code, name) VALUES
  ('admin', 'Administrador'), ('supervisor', 'Supervisor'), ('agent', 'Trabajador')
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (code) VALUES
  ('users.read'), ('users.write'), ('roles.read'),
  ('settings.read'), ('settings.write'), ('audit.read'), ('ai.manage'),
  ('whatsapp.read'), ('whatsapp.manage'),
  ('conversations.read_all'), ('conversations.read_assigned'), ('conversations.reply'), ('conversations.assign'),
  ('catalog.read'), ('catalog.write'),
  ('customers.read'), ('customers.write'),
  ('quotes.read'), ('quotes.write'),
  ('orders.read'), ('orders.write'),
  ('payments.read'), ('payments.write'), ('payments.verify'),
  ('appointments.read'), ('appointments.write'),
  ('warranties.read'), ('warranties.write'), ('warranties.decide'),
  ('reports.read')
ON CONFLICT (code) DO NOTHING;

-- admin: todos
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

-- supervisor
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
  'whatsapp.read', 'conversations.read_all', 'conversations.reply', 'conversations.assign',
  'catalog.read', 'customers.read', 'customers.write', 'quotes.read', 'quotes.write',
  'orders.read', 'orders.write', 'payments.read', 'payments.write', 'payments.verify',
  'appointments.read', 'appointments.write', 'warranties.read', 'warranties.write', 'warranties.decide',
  'reports.read'
) WHERE r.code = 'supervisor'
ON CONFLICT DO NOTHING;

-- agent
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
  'conversations.read_assigned', 'conversations.reply', 'catalog.read',
  'customers.read', 'customers.write', 'quotes.read', 'quotes.write', 'orders.read',
  'appointments.read', 'appointments.write', 'warranties.read', 'warranties.write'
) WHERE r.code = 'agent'
ON CONFLICT DO NOTHING;
